-- CreateIndex
CREATE INDEX "renders_snapshot_id_idx" ON "renders"("snapshot_id");

-- CreateIndex
CREATE INDEX "share_links_created_by_idx" ON "share_links"("created_by");

-- AddForeignKey
ALTER TABLE "renders" ADD CONSTRAINT "renders_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
