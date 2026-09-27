"""Local POSIX PTY regression probe; uses only synthetic credentials, no SSH."""
import errno
import os
import pty
import select
import signal
import subprocess
import sys
import time


def main():
    mode, wrapper, cancel, pid_file = sys.argv[1:]
    child, fd = pty.fork()
    if child == 0:
        os.execl('/bin/sh', 'sh', '-c', wrapper)
    output = bytearray()
    sent_user = sent_secret = cancelled = reaped = False
    descendant = None
    deadline = time.monotonic() + 12
    try:
        while time.monotonic() < deadline:
            if select.select([fd], [], [], 0.05)[0]:
                try:
                    chunk = os.read(fd, 8192)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    chunk = b''
                output.extend(chunk)
            if mode == 'prompt':
                if b'Username' in output and not sent_user:
                    os.write(fd, b'synthetic-account\n')
                    sent_user = True
                if b'Password' in output and not sent_secret:
                    os.write(fd, b'synthetic-password\n')
                    sent_secret = True
            elif b'READY:' in output and not cancelled:
                descendant = int(output.split(b'READY:')[1].splitlines()[0])
                subprocess.run(['/bin/sh', '-c', cancel], check=True, timeout=5)
                cancelled = True
            waited, status = os.waitpid(child, os.WNOHANG)
            if waited:
                reaped = True
                if mode == 'prompt':
                    assert os.waitstatus_to_exitcode(status) == 37, (status, output)
                    assert sent_user and sent_secret and b'ACCEPTED' in output, output
                    assert b'synthetic-account' not in output, output
                    assert b'synthetic-password' not in output, output
                else:
                    assert cancelled and os.waitstatus_to_exitcode(status) != 0, (status, output)
                    for _ in range(40):
                        state = subprocess.run(['ps', '-o', 'stat=', '-p', str(descendant)],
                                               capture_output=True, text=True).stdout.strip()
                        if not state or state.startswith('Z'):
                            break
                        time.sleep(0.05)
                    else:
                        raise AssertionError('cancel left a running descendant')
                assert not os.path.exists(pid_file), 'tracking file was not cleaned'
                return
        raise AssertionError(('PTY probe timed out', output))
    finally:
        if descendant is not None:
            try:
                os.kill(descendant, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if not reaped:
            try:
                os.killpg(child, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(child, 0)
        os.close(fd)


if __name__ == '__main__':
    main()
