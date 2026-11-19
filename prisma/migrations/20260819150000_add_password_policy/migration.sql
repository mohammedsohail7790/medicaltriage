-- NFR-016: administrator-configurable password policy for local accounts.
ALTER TABLE "application_users"
  ADD COLUMN "password_changed_at" TIMESTAMP(3),
  ADD COLUMN "must_change_password" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "password_history" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_history_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "password_history_user_id_created_at_idx" ON "password_history"("user_id", "created_at");

CREATE TABLE "password_policies" (
    "id" TEXT NOT NULL,
    "policy" JSONB NOT NULL,
    "updated_by" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "password_policies_pkey" PRIMARY KEY ("id")
);
