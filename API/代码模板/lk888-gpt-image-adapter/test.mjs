import assert from "node:assert/strict";
import {
  aspectRatioParts,
  exactImageSize,
  extractImages,
  extractTaskId,
  parseMultipart,
  sizeParamsFromFields
} from "./server.mjs";

assert.deepEqual(aspectRatioParts("3:4"), [3, 4]);
assert.equal(exactImageSize("3:4", "2K"), "1728x2304");
assert.equal(exactImageSize("4:3", "2K"), "2304x1728");
assert.equal(exactImageSize("1:1", "2K"), "2304x2304");
assert.equal(sizeParamsFromFields({ image_size: "2K", aspect_ratio: "3:4" }).size, "1728x2304");
assert.equal(sizeParamsFromFields({ size: "1536x2048", image_size: "2K", aspect_ratio: "3:4" }).size, "1536x2048");

assert.equal(extractTaskId({ data: { task_id: "task_123" } }), "task_123");
assert.deepEqual(extractImages({ data: [{ url: "https://cdn.example.com/out.png" }] })[0], {
  type: "url",
  value: "https://cdn.example.com/out.png",
  mimeType: "image/png"
});

const boundary = "XBOUNDARY";
const multipart = Buffer.from(
  [
    `--${boundary}`,
    `Content-Disposition: form-data; name="prompt"`,
    "",
    "hello",
    `--${boundary}`,
    `Content-Disposition: form-data; name="image"; filename="a.png"`,
    "Content-Type: image/png",
    "",
    "PNGDATA",
    `--${boundary}--`,
    ""
  ].join("\r\n"),
  "latin1"
);
const parsed = parseMultipart(multipart, boundary);
assert.equal(parsed.fields.prompt, "hello");
assert.equal(parsed.files[0].name, "image");
assert.equal(parsed.files[0].contentType, "image/png");
assert.equal(parsed.files[0].data.toString("latin1"), "PNGDATA");

console.log("ok");
