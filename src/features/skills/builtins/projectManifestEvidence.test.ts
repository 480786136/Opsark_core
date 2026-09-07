import { describe, expect, it, vi } from "vitest";
import { inspectProjectManifest } from "@/features/skills/builtins/projectManifestEvidence";

const npm = (value: unknown) => inspectProjectManifest("/srv/app/package.json", JSON.stringify(value));
const pom = (body = "", attributes = "") => `<project${attributes}><modelVersion>4.0.0</modelVersion><artifactId>app</artifactId>${body}</project>`;

describe("project manifest declaration evidence", () => {
  it("does not treat literal POSIX backslashes as directory separators", () => {
    expect(inspectProjectManifest("/srv/app\\package.json", '{"scripts":{"build":"vite build"}}')).toBeUndefined();
  });
  it("recognizes npm declarations without returning source text or secrets", () => {
    const result = npm({ scripts: { build: "TOKEN=private-value vite build", start: "vite" },
      dependencies: { vue: "^3.5.0", "@private/client": "git+https://user:password@example.test/repo.git" },
      engines: { node: ">=20", npm: ">=10" }, packageManager: "pnpm@9.0.0" });
    expect(result).toEqual({ manifestFormat: "npm", buildEntryKnown: true, runtimeRequirementKnown: true });
    expect(JSON.stringify(result)).not.toMatch(/private-value|password|vite/);
  });

  it("separates identifying a package from knowing its build and runtime requirements", () => {
    for (const value of [
      { scripts: { start: "node app.js", prepare: "husky" } },
      { dependencies: { vue: "workspace:*" } },
      { devDependencies: { typescript: "file:../typescript" } },
      { engines: { npm: ">=10" } },
      { packageManager: "yarn@4.0.0+sha224.abc" },
    ]) expect(npm(value)).toEqual({ manifestFormat: "npm", buildEntryKnown: false, runtimeRequirementKnown: false });
    expect(npm({ engines: { node: "*" } })?.runtimeRequirementKnown).toBe(true);
  });

  it("ignores unrelated nested data while checking the recognized fields", () => {
    expect(npm({ scripts: { build: "node -e \"console.log('build')\"" }, custom: [{ nested: { build: 1 } }],
      overrides: { a: { b: "^1" } } })?.buildEntryKnown).toBe(true);
    expect(npm({ metadata: { scripts: { build: "vite build" } } })).toBeUndefined();
  });

  it.each([
    null, [], "package", {}, { name: "ordinary-json", version: "1.0.0" },
    { scripts: {} }, { dependencies: {}, devDependencies: {}, engines: {} },
    { scripts: ["vite build"] }, { scripts: { build: true } }, { scripts: { build: "  " } },
    { scripts: { build: "vite build", test: {} } }, { scripts: { "": "vite build" } },
    { dependencies: { vue: { version: "^3" } } }, { devDependencies: null },
    { dependencies: { "bad name": "^1" } }, { dependencies: { vue: "" } },
    { engines: { node: 20 } }, { engines: ["node"] }, { engines: { node: "\0" } },
    { packageManager: {} }, { packageManager: "" }, { packageManager: "pnpm" },
    { packageManager: "pnpm@" }, { scripts: { build: "vite build" }, dependencies: false },
  ])("rejects empty, ambiguous or malformed npm field shapes: %j", (value) => {
    expect(npm(value)).toBeUndefined();
  });

  it("rejects duplicate JSON keys including escaped equivalents and nested duplicates", () => {
    for (const content of [
      '{"scripts":{"build":"vite"},"scripts":{"build":"other"}}',
      '{"scripts":{"build":"vite","bu\\u0069ld":"other"}}',
      '{"scripts":{"build":"vite"},"custom":{"key":1,"key":2}}',
      '{"scripts":{"build":"vite"},}',
    ]) expect(inspectProjectManifest("package.json", content)).toBeUndefined();
    expect(npm({ scripts: { build: "echo '{\"build\":1,\"build\":2}'" }, custom: [{ key: 1 }, { key: 2 }] })?.buildEntryKnown).toBe(true);
  });

  it("requires the correct declaration file, never a README or lockfile", () => {
    const content = JSON.stringify({ scripts: { build: "vite build" } });
    for (const path of ["README.md", "package-lock.json", "npm-shrinkwrap.json", "config.json", "package.json.bak", "package.json/"])
      expect(inspectProjectManifest(path, content)).toBeUndefined();
    expect(inspectProjectManifest("C:\\app\\package.json", content)).toBeUndefined();
    expect(inspectProjectManifest("package.json", "# README\nUse npm run build")).toBeUndefined();
    expect(inspectProjectManifest("pom.xml", "# README\nUse Maven")).toBeUndefined();
    expect(inspectProjectManifest("package.json", " ")).toBeUndefined();
  });

  it("recognizes plain, default-namespaced and prefixed Maven POMs", () => {
    const expected = { manifestFormat: "maven", buildEntryKnown: true, runtimeRequirementKnown: false };
    expect(inspectProjectManifest("pom.xml", pom())).toEqual(expected);
    expect(inspectProjectManifest("pom.xml", pom("", ' xmlns="http://maven.apache.org/POM/4.0.0"'))).toEqual(expected);
    expect(inspectProjectManifest("pom.xml", '<m:project xmlns:m="http://maven.apache.org/POM/4.0.0"><m:modelVersion>4.0.0</m:modelVersion><m:artifactId>app</m:artifactId></m:project>')).toEqual(expected);
    expect(inspectProjectManifest("pom.xml", '<project xmlns="http://maven.apache.org/POM/4.1.0"><modelVersion>4.1.0</modelVersion><artifactId>app</artifactId></project>')).toEqual(expected);
    expect(inspectProjectManifest("pom.xml", '<project><modelVersion>4.0.0</modelVersion><parent><artifactId>parent-app</artifactId></parent></project>')).toEqual(expected);
  });

  it("records explicit Java declarations, not dependency or compiler-plugin versions", () => {
    for (const key of ["java.version", "maven.compiler.release", "maven.compiler.source", "maven.compiler.target"])
      expect(inspectProjectManifest("pom.xml", pom(`<properties><${key}>17</${key}></properties>`))?.runtimeRequirementKnown).toBe(true);
    const compiler = '<build><plugins><plugin><artifactId>maven-compiler-plugin</artifactId><configuration><release>${jdk.version}</release></configuration></plugin></plugins></build>';
    expect(inspectProjectManifest("pom.xml", pom(compiler))?.runtimeRequirementKnown).toBe(true);
    expect(inspectProjectManifest("pom.xml", pom('<build><plugins><plugin><artifactId>maven-compiler-plugin</artifactId><version>3.14.0</version></plugin></plugins></build>'))?.runtimeRequirementKnown).toBe(false);
    expect(inspectProjectManifest("pom.xml", pom('<properties><java.version><nested>17</nested></java.version></properties>'))?.runtimeRequirementKnown).toBe(false);
    expect(inspectProjectManifest("pom.xml", pom('<properties><java.version>not-a-version</java.version></properties>'))?.runtimeRequirementKnown).toBe(false);
    expect(inspectProjectManifest("pom.xml", pom('<dependencies><dependency><artifactId>java</artifactId><version>17</version></dependency></dependencies>'))?.runtimeRequirementKnown).toBe(false);
    expect(inspectProjectManifest("pom.xml", pom('<profiles><profile><properties><java.version>17</java.version></properties></profile></profiles>'))?.runtimeRequirementKnown).toBe(false);
  });

  it.each([
    '<project>', '<project><modelVersion>4.0.0</modelVersion><artifactId>app</project>',
    '<project><modelVersion>4.0.0</modelVersion><artifactId>app</artifactId></project><extra/>',
    '<project><modelVersion>4.0.0</modelVersion><artifactId>&undefined;</artifactId></project>',
    '<project attribute="unterminated><modelVersion>4.0.0</modelVersion><artifactId>app</artifactId></project>',
    '<project><artifactId>app</artifactId></project>',
    '<project><modelVersion>5.0.0</modelVersion><artifactId>app</artifactId></project>',
    '<project><modelVersion><version>4.0.0</version></modelVersion><artifactId>app</artifactId></project>',
    '<project><modelVersion>4.0.0</modelVersion><artifactId><name>app</name></artifactId></project>',
    '<project><modelVersion>4.0.0</modelVersion><dependencies><dependency><artifactId>other</artifactId></dependency></dependencies></project>',
    '<project><modelVersion>4.0.0</modelVersion><artifactId>app</artifactId><artifactId>other</artifactId></project>',
    '<project><modelVersion>4.0.0</modelVersion><modelVersion>4.0.0</modelVersion><artifactId>app</artifactId></project>',
    '<project><modelVersion>4.0.0</modelVersion><artifactId>bad name</artifactId></project>',
    '<project xmlns="urn:unrelated"><modelVersion>4.0.0</modelVersion><artifactId>app</artifactId></project>',
    '<project xmlns="http://maven.apache.org/POM/4.1.0"><modelVersion>4.0.0</modelVersion><artifactId>app</artifactId></project>',
    '<project xmlns:x="urn:foreign"><x:modelVersion>4.0.0</x:modelVersion><artifactId>app</artifactId></project>',
    '<project xmlns:x="urn:foreign"><modelVersion>4.0.0</modelVersion><x:artifactId>app</x:artifactId></project>',
  ])("rejects invalid or unrelated XML declarations: %s", (content) => {
    expect(inspectProjectManifest("pom.xml", content)).toBeUndefined();
  });

  it("blocks DTDs and entity declarations before DOM parsing", () => {
    const parser = vi.spyOn(DOMParser.prototype, "parseFromString");
    for (const declaration of [
      '<!DOCTYPE project SYSTEM "https://example.test/external.dtd">',
      '<!DOCTYPE project [<!ENTITY secret SYSTEM "file:///etc/passwd">]>',
      '<!DOCTYPE project [<!ENTITY a "value"><!ENTITY b "&a;&a;">]>',
      '<!ENTITY secret SYSTEM "file:///etc/passwd">',
    ]) expect(inspectProjectManifest("pom.xml", declaration + pom())).toBeUndefined();
    expect(parser).not.toHaveBeenCalled();
    parser.mockRestore();
  });

  it("ignores foreign namespaces in compiler declarations", () => {
    expect(inspectProjectManifest("pom.xml", pom('<properties xmlns:x="urn:foreign"><x:java.version>17</x:java.version></properties>'))?.runtimeRequirementKnown).toBe(false);
  });
});
