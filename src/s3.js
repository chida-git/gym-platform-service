const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const s3 = new S3Client({ region: process.env.AWS_REGION });

async function uploadBuffer({ Bucket, Key, Body, ContentType, CacheControl }) {
  const cmd = new PutObjectCommand({ Bucket, Key, Body, ContentType, ACL: 'public-read', CacheControl });
  await s3.send(cmd);
  return { bucket: Bucket, key: Key };
}

async function listByPrefix({ Bucket, Prefix }) {
  const cmd = new ListObjectsV2Command({ Bucket, Prefix });
  const res = await s3.send(cmd);
  return (res.Contents || []).map(o => ({ key: o.Key, size: o.Size, lastModified: o.LastModified }));
}

async function deleteKey({ Bucket, Key }) {
  const cmd = new DeleteObjectCommand({ Bucket, Key });
  await s3.send(cmd);
  return true;
}

module.exports = { s3, uploadBuffer, listByPrefix, deleteKey };
