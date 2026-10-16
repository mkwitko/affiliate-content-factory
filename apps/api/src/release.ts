/** Deployed revision (short git sha set by the deploy workflow), shown as semver build metadata. */
export const releaseVersion = `1.0.0+${process.env.MONEY_MAKER_RELEASE ?? "dev"}`;
