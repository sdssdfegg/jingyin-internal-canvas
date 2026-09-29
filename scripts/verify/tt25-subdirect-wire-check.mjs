import assert from "node:assert/strict";
import { buildImageRequestVariants } from "../../server/channel.js";

const files = [{ name: "reference.png", type: "image/png", arrayBuffer: async () => new ArrayBuffer(4) }];
const base = {
  model: "tt-image-2.5",
  prompt: "wire check",
  n: 1,
  imageSize: "2K",
  aspectRatio: "3:4",
  dispatchMode: "manual",
  referenceDataUrls: ["data:image/png;base64,AAAA"]
};

const subdirect = buildImageRequestVariants({ ...base, channelId: "silent-tt25-line-07" }, files);
assert.equal(subdirect.length, 1);
assert.equal(subdirect[0].protocol, "json");
assert.equal(subdirect[0].path, "/images/generations");
const body = JSON.parse(await subdirect[0].createBody());
assert.equal(body.channelId, "silent-tt25-line-07");
assert.deepEqual(body.image_urls, base.referenceDataUrls);

const origin = buildImageRequestVariants({ ...base, channelId: "silent-tt25-line-06" }, files);
assert.equal(origin.length, 1);
assert.equal(origin[0].protocol, "multipart");
assert.equal(origin[0].path, "/images/edits");

console.log("tt25-subdirect-wire-check: 6/6 passed");
