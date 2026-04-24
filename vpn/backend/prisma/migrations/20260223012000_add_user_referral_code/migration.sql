ALTER TABLE "users"
ADD COLUMN "referral_code" TEXT;

CREATE UNIQUE INDEX "users_referral_code_key" ON "users"("referral_code");
