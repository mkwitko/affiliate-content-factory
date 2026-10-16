-- Home worker images wait for a human decision (ADR 0012). Additive enum value only;
-- rollback: move PENDING_REVIEW rows to ARCHIVED before dropping the value.
ALTER TYPE "AssetState" ADD VALUE 'PENDING_REVIEW';
