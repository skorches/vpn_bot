-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'BLOCKED');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'PAUSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProfileType" AS ENUM ('STANDARD', 'ANTI');

-- CreateEnum
CREATE TYPE "ProfileState" AS ENUM ('ACTIVE', 'DISABLED', 'DELETED');

-- CreateEnum
CREATE TYPE "ProvisionAction" AS ENUM ('CREATE', 'DISABLE', 'DELETE', 'REFRESH');

-- CreateEnum
CREATE TYPE "ProvisionStatus" AS ENUM ('SUCCESS', 'FAILED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "telegram_chat_id" BIGINT NOT NULL,
    "telegram_username" TEXT,
    "telegram_first_name" TEXT,
    "telegram_last_name" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "duration_days" INTEGER NOT NULL,
    "traffic_bytes" BIGINT NOT NULL,
    "device_limit" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "plan_id" TEXT,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "starts_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "traffic_limit_bytes" BIGINT,
    "device_limit" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vpn_profiles" (
    "id" TEXT NOT NULL,
    "profile_code" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "subscription_id" TEXT,
    "inbound_id" INTEGER NOT NULL,
    "xui_client_id" TEXT NOT NULL,
    "xui_sub_id" TEXT,
    "profile_type" "ProfileType" NOT NULL DEFAULT 'STANDARD',
    "state" "ProfileState" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vpn_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provision_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "subscription_id" TEXT,
    "vpn_profile_id" TEXT,
    "action" "ProvisionAction" NOT NULL,
    "status" "ProvisionStatus" NOT NULL,
    "error_message" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provision_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_telegram_chat_id_key" ON "users"("telegram_chat_id");

-- CreateIndex
CREATE UNIQUE INDEX "plans_code_key" ON "plans"("code");

-- CreateIndex
CREATE INDEX "idx_subscriptions_user_id" ON "subscriptions"("user_id");

-- CreateIndex
CREATE INDEX "idx_subscriptions_status" ON "subscriptions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "vpn_profiles_profile_code_key" ON "vpn_profiles"("profile_code");

-- CreateIndex
CREATE INDEX "idx_vpn_profiles_user_id" ON "vpn_profiles"("user_id");

-- CreateIndex
CREATE INDEX "idx_vpn_profiles_subscription_id" ON "vpn_profiles"("subscription_id");

-- CreateIndex
CREATE INDEX "idx_vpn_profiles_xui_ref" ON "vpn_profiles"("inbound_id", "xui_client_id");

-- CreateIndex
CREATE INDEX "idx_provision_events_user_id" ON "provision_events"("user_id");

-- CreateIndex
CREATE INDEX "idx_provision_events_created_at" ON "provision_events"("created_at");

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vpn_profiles" ADD CONSTRAINT "vpn_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vpn_profiles" ADD CONSTRAINT "vpn_profiles_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provision_events" ADD CONSTRAINT "provision_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provision_events" ADD CONSTRAINT "provision_events_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provision_events" ADD CONSTRAINT "provision_events_vpn_profile_id_fkey" FOREIGN KEY ("vpn_profile_id") REFERENCES "vpn_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

