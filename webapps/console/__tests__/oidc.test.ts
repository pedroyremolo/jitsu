import { ParseJSONConfigFromEnv } from "../lib/oidc"; // Update with the correct path

describe("ParseJSONConfigFromEnv", () => {
  it("should return parsed JSON object when a valid JSON string is provided", () => {
    const env = '{"key":"value"}';
    const result = ParseJSONConfigFromEnv(env);
    expect(result).toEqual({ key: "value" });
  });

  it("should return undefined for an empty string", () => {
    const env = "";
    const result = ParseJSONConfigFromEnv(env);
    expect(result).toBeUndefined();
  });

  it("should return undefined for a string that is equal to '\"\"'", () => {
    const env = '""';
    const result = ParseJSONConfigFromEnv(env);
    expect(result).toBeUndefined();
  });

  it("should log an error and return undefined for an invalid JSON string", () => {
    const env = "invalid json";
    console.error = jest.fn();

    const result = ParseJSONConfigFromEnv(env);

    expect(console.error).toHaveBeenCalledWith("Failed to parse JSON config from env", expect.any(SyntaxError));
    expect(result).toBeUndefined();
  });
});
