const encoder = new TextEncoder();
export const randomSecret = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
}
export async function hash(value: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}
async function hmacKey(secret: string) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function sign(value: string, secret: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(value))));
}
export async function verify(value: string, signature: string, secret: string): Promise<boolean> {
  try { return await crypto.subtle.verify('HMAC', await hmacKey(secret), decode(signature), encoder.encode(value)); }
  catch { return false; }
}
async function encryptionKey(master: string) {
  const bytes = decode(master);
  if (bytes.length !== 32) throw new Error('MASTER_KEY must contain 32 random bytes');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encrypt(value: unknown, master: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode('settings:v1') }, await encryptionKey(master), encoder.encode(JSON.stringify(value)));
  return `v1.${base64url(iv)}.${base64url(new Uint8Array(data))}`;
}
export async function decrypt<T>(value: string, master: string): Promise<T> {
  const [version, iv, data] = value.split('.');
  if (version !== 'v1') throw new Error('Unknown encryption version');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(iv), additionalData: encoder.encode('settings:v1') }, await encryptionKey(master), decode(data));
  return JSON.parse(new TextDecoder().decode(plain));
}
