import process from "node:process";

const required = ["DATABASE_URL"];
const optional = ["DIRECT_URL", "TEST_DATABASE_URL"];
const groups = {
  CANVA: ["CANVA_CLIENT_ID", "CANVA_CLIENT_SECRET"],
  CLOUDFLARE_WORKERS_AI: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_AI_GATEWAY"],
  MERCADO_LIVRE: ["MERCADO_LIVRE_CLIENT_ID", "MERCADO_LIVRE_CLIENT_SECRET"],
  R2: ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"],
  POST_FOR_ME_WEBHOOK: ["POST_FOR_ME_WEBHOOK_SECRET"],
};

const isPostgresUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "postgres:" || url.protocol === "postgresql:";
  } catch {
    return false;
  }
};

const missing = required.filter((name) => !process.env[name]);
const invalid = ["DATABASE_URL", "DIRECT_URL", "TEST_DATABASE_URL"].filter(
  (name) => process.env[name] && !isPostgresUrl(process.env[name]),
);
const incompleteGroups = Object.entries(groups).flatMap(([group, names]) => {
  const configured = names.filter((name) => Boolean(process.env[name]));
  return configured.length > 0 && configured.length < names.length
    ? [`${group}: ${names.join(", ")}`]
    : [];
});

if (missing.length > 0 || invalid.length > 0 || incompleteGroups.length > 0) {
  if (missing.length > 0) console.error(`Missing required variables: ${missing.join(", ")}`);
  if (invalid.length > 0) console.error(`Invalid PostgreSQL URLs: ${invalid.join(", ")}`);
  if (incompleteGroups.length > 0)
    console.error(`Incomplete configuration groups: ${incompleteGroups.join("; ")}`);
  console.error(
    "Copy .env.example to a local, untracked .env file and provide safe development values.",
  );
  process.exitCode = 1;
} else {
  console.log("Environment shape is valid; credentials and database reachability were not tested.");
  const absentOptional = optional.filter((name) => !process.env[name]);
  if (absentOptional.length > 0)
    console.log(`Optional variables not set: ${absentOptional.join(", ")}`);
}
