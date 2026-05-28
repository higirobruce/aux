-- CreateEnum
CREATE TYPE "storage_mode" AS ENUM ('cloud', 'local');

-- CreateEnum
CREATE TYPE "collaborator_role" AS ENUM ('owner', 'editor', 'listener');

-- CreateEnum
CREATE TYPE "render_format" AS ENUM ('wav', 'flac', 'mp3', 'aac');

-- CreateEnum
CREATE TYPE "render_status" AS ENUM ('queued', 'running', 'done', 'failed');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "storage_mode" "storage_mode" NOT NULL,
    "byo_bucket" JSONB,
    "last_opened_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stems" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "s3_key" TEXT,
    "length_ms" INTEGER NOT NULL,
    "channels" SMALLINT NOT NULL,
    "sample_rate" INTEGER NOT NULL,
    "peak_db" DOUBLE PRECISION NOT NULL,
    "lufs_i" DOUBLE PRECISION NOT NULL,
    "fingerprint_v1" BYTEA,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stems_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "snapshots" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "parent_id" TEXT,
    "doc_state" BYTEA NOT NULL,
    "message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collaborators" (
    "session_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" "collaborator_role" NOT NULL,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collaborators_pkey" PRIMARY KEY ("session_id","user_id")
);

-- CreateTable
CREATE TABLE "renders" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "snapshot_id" TEXT NOT NULL,
    "format" "render_format" NOT NULL,
    "target_lufs" DOUBLE PRECISION,
    "s3_key" TEXT,
    "status" "render_status" NOT NULL DEFAULT 'queued',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "renders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "share_links" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "snapshot_id" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "share_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_presets" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "plugin" TEXT NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "state" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_presets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chain_presets" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "chain" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chain_presets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "sessions_owner_id_idx" ON "sessions"("owner_id");

-- CreateIndex
CREATE INDEX "stems_session_id_idx" ON "stems"("session_id");

-- CreateIndex
CREATE INDEX "snapshots_session_id_idx" ON "snapshots"("session_id");

-- CreateIndex
CREATE INDEX "snapshots_parent_id_idx" ON "snapshots"("parent_id");

-- CreateIndex
CREATE INDEX "renders_session_id_idx" ON "renders"("session_id");

-- CreateIndex
CREATE INDEX "share_links_session_id_idx" ON "share_links"("session_id");

-- CreateIndex
CREATE INDEX "share_links_snapshot_id_idx" ON "share_links"("snapshot_id");

-- CreateIndex
CREATE INDEX "user_presets_owner_id_idx" ON "user_presets"("owner_id");

-- CreateIndex
CREATE INDEX "user_presets_plugin_idx" ON "user_presets"("plugin");

-- CreateIndex
CREATE INDEX "chain_presets_owner_id_idx" ON "chain_presets"("owner_id");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stems" ADD CONSTRAINT "stems_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collaborators" ADD CONSTRAINT "collaborators_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collaborators" ADD CONSTRAINT "collaborators_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "renders" ADD CONSTRAINT "renders_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_presets" ADD CONSTRAINT "user_presets_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chain_presets" ADD CONSTRAINT "chain_presets_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
