import { describe, expect, it } from "bun:test";
import { MockR2Storage } from "../storage/mock-r2.ts";

describe("Phase 1: Cloudflare R2 Storage Abstraction", () => {
  it("should write and read objects with MD5 ETags", async () => {
    const r2 = new MockR2Storage("test-bucket");
    const testData = new TextEncoder().encode("hello continuity");

    // Initial put
    const putRes = await r2.putObject("repo/wal_index.json", testData);
    expect(putRes.status).toBe(200);
    expect(putRes.etag).toBeDefined();
    expect(typeof putRes.etag).toBe("string");

    // Standard get
    const getRes = await r2.getObject("repo/wal_index.json");
    expect(getRes.status).toBe(200);
    expect(getRes.etag).toBe(putRes.etag);
    expect(new TextDecoder().decode(getRes.data)).toBe("hello continuity");
  });

  it("should return HTTP 304 Not Modified when ETag matches", async () => {
    const r2 = new MockR2Storage("test-bucket");
    const data = "immutable-content";
    const putRes = await r2.putObject("wal/packs/pack-1.pack", data);

    // Conditional GET with matching ETag
    const get304 = await r2.getObject("wal/packs/pack-1.pack", {
      ifNoneMatch: putRes.etag,
    });
    expect(get304.status).toBe(304);
    expect(get304.data).toBeUndefined(); // Zero payload transfer!
    expect(get304.etag).toBe(putRes.etag);

    // Conditional GET with stale ETag should return 200 with full data
    const get200 = await r2.getObject("wal/packs/pack-1.pack", {
      ifNoneMatch: '"stale-etag-12345"',
    });
    expect(get200.status).toBe(200);
    expect(get200.data).toBeDefined();
  });

  it("should enforce Atomic Compare-And-Swap (CAS) with If-Match", async () => {
    const r2 = new MockR2Storage("test-bucket");
    const key = "cursor-repo/wal_index.json";

    // 1. Creation CAS: should succeed when ifMatch is "NONE"
    const createRes = await r2.putObject(key, "version 1", { ifMatch: "NONE" });
    expect(createRes.status).toBe(200);
    const etagV1 = createRes.etag!;

    // 2. Creation CAS: should fail if object already exists
    const duplicateCreate = await r2.putObject(key, "version 1 duplicate", {
      ifMatch: "NONE",
    });
    expect(duplicateCreate.status).toBe(412);

    // 3. Successful CAS update: provide exact current ETag
    const updateRes = await r2.putObject(key, "version 2", { ifMatch: etagV1 });
    expect(updateRes.status).toBe(200);
    const etagV2 = updateRes.etag!;
    expect(etagV2).not.toBe(etagV1);

    // 4. Stale CAS update: competing write trying to update using old etagV1
    const staleUpdate = await r2.putObject(key, "competing write", { ifMatch: etagV1 });
    expect(staleUpdate.status).toBe(412);
    expect(staleUpdate.error).toContain("Precondition Failed");

    // 5. Verify the value was not corrupted by the stale write
    const finalGet = await r2.getObject(key);
    expect(finalGet.status).toBe(200);
    expect(new TextDecoder().decode(finalGet.data)).toBe("version 2");
  });

  it("should list and delete objects properly", async () => {
    const r2 = new MockR2Storage("test-bucket");
    await r2.putObject("repos/repo1/wal/001.pack", "data 1");
    await r2.putObject("repos/repo1/wal/002.pack", "data 2");
    await r2.putObject("repos/repo2/wal/001.pack", "data 3");

    const repo1Packs = await r2.listObjects("repos/repo1/wal/");
    expect(repo1Packs).toEqual([
      "repos/repo1/wal/001.pack",
      "repos/repo1/wal/002.pack",
    ]);

    const deleted = await r2.deleteObject("repos/repo1/wal/001.pack");
    expect(deleted).toBe(true);

    const afterDelete = await r2.listObjects("repos/repo1/wal/");
    expect(afterDelete).toEqual(["repos/repo1/wal/002.pack"]);
  });
});
