CREATE TABLE "pre_authorized_emails" (
    "email" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pre_authorized_emails_pkey" PRIMARY KEY ("email")
);
