import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { createReadStream } from "node:fs";
import type {
  R2StorageInterface,
  GetObjectOptions,
  GetObjectResult,
  PutObjectOptions,
  PutObjectResult,
} from "../types/storage.ts";

export interface CloudflareR2Config {
  accountId?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  bucketName: string;
  endpointUrl?: string; // Optional custom endpoint for MinIO/LocalStack/Cloudflare
  region?: string;
}

/**
 * Production Cloudflare R2 client using standard S3 compatibility.
 * Configured for Cloudflare R2's endpoint: https://<account_id>.r2.cloudflarestorage.com
 */
export class CloudflareR2Storage implements R2StorageInterface {
  private readonly client: S3Client;
  public readonly bucketName: string;

  constructor(config: CloudflareR2Config) {
    this.bucketName = config.bucketName;

    const endpoint =
      config.endpointUrl ??
      (config.accountId
        ? `https://${config.accountId}.r2.cloudflarestorage.com`
        : process.env.R2_ENDPOINT_URL);

    const accessKeyId =
      config.accessKeyId ??
      process.env.R2_ACCESS_KEY_ID ??
      process.env.AWS_ACCESS_KEY_ID ??
      "";

    const secretAccessKey =
      config.secretAccessKey ??
      process.env.R2_SECRET_ACCESS_KEY ??
      process.env.AWS_SECRET_ACCESS_KEY ??
      "";

    this.client = new S3Client({
      region: config.region ?? "auto",
      endpoint,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });
  }

  async getObject(key: string, options?: GetObjectOptions): Promise<GetObjectResult> {
    const cmd = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      IfNoneMatch: options?.ifNoneMatch,
    });

    try {
      const resp = await this.client.send(cmd);
      const data = resp.Body ? await resp.Body.transformToByteArray() : new Uint8Array();
      return {
        status: 200,
        data,
        etag: resp.ETag,
      };
    } catch (err: any) {
      const httpStatus = err?.$metadata?.httpStatusCode;
      const errorCode = err?.name || err?.Code;

      // Conditional 304 Not Modified
      if (httpStatus === 304 || errorCode === "304") {
        return {
          status: 304,
          etag: options?.ifNoneMatch,
        };
      }

      // 404 Not Found
      if (httpStatus === 404 || errorCode === "NoSuchKey") {
        return { status: 404 };
      }

      throw err;
    }
  }

  async putObject(
    key: string,
    data: Uint8Array | string,
    options?: PutObjectOptions
  ): Promise<PutObjectResult> {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;

    const cmd = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      Body: bytes,
      IfMatch: options?.ifMatch && options.ifMatch !== "NONE" ? options.ifMatch : undefined,
    });

    try {
      const resp = await this.client.send(cmd);
      return {
        status: 200,
        etag: resp.ETag,
      };
    } catch (err: any) {
      const httpStatus = err?.$metadata?.httpStatusCode;
      const errorCode = err?.name || err?.Code;

      // Conditional CAS 412 Precondition Failed
      if (httpStatus === 412 || errorCode === "PreconditionFailed") {
        return {
          status: 412,
          error: "Precondition Failed: ETag mismatch on R2 CAS",
        };
      }

      throw err;
    }
  }

  async uploadFile(
    key: string,
    filePath: string,
    options?: PutObjectOptions
  ): Promise<PutObjectResult> {
    const fileStream = createReadStream(filePath);
    const parallelUpload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucketName,
        Key: key,
        Body: fileStream,
      },
      partSize: 5 * 1024 * 1024,
      queueSize: 4,
    });

    try {
      const resp = await parallelUpload.done();
      return {
        status: 200,
        etag: resp.ETag,
      };
    } catch (err: any) {
      const httpStatus = err?.$metadata?.httpStatusCode;
      const errorCode = err?.name || err?.Code;

      if (httpStatus === 412 || errorCode === "PreconditionFailed") {
        return {
          status: 412,
          error: "Precondition Failed: ETag mismatch on R2 CAS",
        };
      }

      throw err;
    }
  }

  async listObjects(prefix: string): Promise<string[]> {
    const cmd = new ListObjectsV2Command({
      Bucket: this.bucketName,
      Prefix: prefix,
    });

    const resp = await this.client.send(cmd);
    return (resp.Contents ?? []).map((item) => item.Key!).filter(Boolean);
  }

  async deleteObject(key: string): Promise<boolean> {
    const cmd = new DeleteObjectCommand({
      Bucket: this.bucketName,
      Key: key,
    });

    await this.client.send(cmd);
    return true;
  }
}
