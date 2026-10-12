function validate(env) {
  const missing = [
    "DATABASE_URL",
    "TRUSTED_PROXY_SECRET",
    "MONITORING_TOKEN",
  ].filter((name) => !env[name]);
  if (missing.length)
    throw new Error("Missing required settings: " + missing.join(", "));
  if (
    !["postgres:", "postgresql:"].includes(new URL(env.DATABASE_URL).protocol)
  )
    throw new Error("DATABASE_URL must use PostgreSQL.");
  for (const name of ["TRUSTED_PROXY_SECRET", "MONITORING_TOKEN"])
    if (env[name].length < 32 || !/^[A-Za-z0-9_-]+$/.test(env[name]))
      throw new Error(name + " must contain at least 32 URL-safe characters.");
  if (!!env.OPENAI_API_KEY !== !!env.OPENAI_MODEL)
    throw new Error(
      "OPENAI_API_KEY and OPENAI_MODEL must be configured together.",
    );
  return true;
}
module.exports = { validate };
if (require.main === module) {
  try {
    validate(process.env);
    console.log("Production environment configuration is valid.");
  } catch (error) {
    console.error(
      error.message.startsWith("Invalid URL")
        ? "DATABASE_URL is invalid."
        : error.message,
    );
    process.exitCode = 1;
  }
}
