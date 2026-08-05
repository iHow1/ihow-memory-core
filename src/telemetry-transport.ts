// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import http from 'node:http';
import https from 'node:https';

const MAX_RESPONSE_BYTES = 4_096;

export async function sendTelemetryBatch(
  endpoint: URL,
  payload: string,
  timeoutMs: number,
): Promise<{ accepted: number }> {
  const requestFn = endpoint.protocol === 'https:' ? https.request : http.request;
  return new Promise((resolve, reject) => {
    const request = requestFn(endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
      timeout: timeoutMs,
    }, (response) => {
      const status = response.statusCode ?? 0;
      const contentType = String(response.headers['content-type'] ?? '').toLowerCase();
      let size = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          response.destroy(new Error('telemetry_response_too_large'));
          return;
        }
        chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('end', () => {
        if (status < 200 || status >= 300) {
          reject(new Error(`telemetry_http_status_${status}`));
          return;
        }
        if (!contentType.includes('application/json')) {
          reject(new Error('telemetry_response_content_type_invalid'));
          return;
        }
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
          if (parsed.schemaVersion !== 1 || !Number.isSafeInteger(parsed.accepted) || Number(parsed.accepted) < 0) {
            throw new Error('telemetry_response_invalid');
          }
          resolve({ accepted: Number(parsed.accepted) });
        } catch (error) {
          reject(error instanceof Error && error.message.startsWith('telemetry_')
            ? error
            : new Error('telemetry_response_invalid'));
        }
      });
    });
    request.once('timeout', () => request.destroy(new Error('telemetry_request_timeout')));
    request.once('error', reject);
    request.end(payload);
  });
}
