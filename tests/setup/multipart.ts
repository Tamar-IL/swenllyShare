/** Hand-rolled `multipart/form-data` body builder for `app.inject()` tests — small enough
 * not to need a dependency, and lets tests control the exact filename/content-type/bytes
 * for upload-cap and content-type tests. */
export function buildMultipartUpload(params: {
  fieldName: string;
  filename: string;
  content: Buffer;
  contentType: string;
}): { body: Buffer; contentType: string } {
  const boundary = `----swenllyTestBoundary${Math.random().toString(16).slice(2)}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${params.fieldName}"; filename="${params.filename}"\r\n` +
      `Content-Type: ${params.contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Buffer.concat([head, params.content, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}
