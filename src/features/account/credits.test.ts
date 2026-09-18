import { describe, expect, it } from "vitest";
import { tokensToCredits } from "./credits";

describe("tokensToCredits", () => {
  it.each([[0, 0], [1, 1], [10_000, 1], [11_000, 2], [20_000, 2]])(
    "converts %i tokens to %i credits",
    (tokens, credits) => expect(tokensToCredits(tokens)).toBe(credits),
  );
});
