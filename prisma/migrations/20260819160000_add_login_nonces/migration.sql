-- NFR-146: one-time login nonces, shared across instances.
CREATE TABLE "login_nonces" (
    "nonce" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "login_nonces_pkey" PRIMARY KEY ("nonce")
);
CREATE INDEX "login_nonces_expires_at_idx" ON "login_nonces"("expires_at");
