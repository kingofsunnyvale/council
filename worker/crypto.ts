const encoder = new TextEncoder();
export function encode(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
export function decode(value: string): Uint8Array<ArrayBuffer> { return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0)); }
export const random = () => encode(crypto.getRandomValues(new Uint8Array(32)));
export async function hash(value: string): Promise<string> { return encode(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))); }
export async function equal(a: string, b: string): Promise<boolean> {
  const x = decode(await hash(a)); const y = decode(await hash(b)); let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
type Keyring = { current: string; keys: Record<string, string> };
async function key(raw: string, version?: string) {
  const ring = JSON.parse(raw) as Keyring; const id = version ?? ring.current;
  if (!ring.keys[id]) throw new Error('Missing encryption key version.');
  return { id, key: await crypto.subtle.importKey('raw', decode(ring.keys[id]), 'AES-GCM', false, ['encrypt','decrypt']) };
}
export async function seal(text: string, owner: string, ring: string): Promise<string> {
  const k = await key(ring); const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: encoder.encode(owner) }, k.key, encoder.encode(text));
  return [k.id, encode(nonce), encode(new Uint8Array(encrypted))].join('.');
}
export async function unseal(text: string, owner: string, ring: string): Promise<string> {
  const [version, iv, encrypted] = text.split('.'); const k = await key(ring, version);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(iv), additionalData: encoder.encode(owner) }, k.key, decode(encrypted)));
}
