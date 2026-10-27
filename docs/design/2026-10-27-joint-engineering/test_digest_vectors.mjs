// Documentation reference serializer only; not imported by the product.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const vectors=JSON.parse(readFileSync(new URL('./fixtures/digest-vectors.json',import.meta.url),'utf8')).vectors;
function canonical(value) {
  if (value===null || typeof value==='string' || typeof value==='boolean') return JSON.stringify(value);
  if (typeof value==='number') {
    if (!Number.isSafeInteger(value) || Object.is(value,-0)) throw Error('invalid integer');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
}
let checked=0;
for (const vector of vectors.filter(x=>x.valid)) {
  const text=canonical(vector.input);
  const bytes=Buffer.from(vector.domain+'\n'+text,'utf8');
  const digest=createHash('sha256').update(bytes).digest('hex');
  if (text!==vector.canonical_json || bytes.toString('hex')!==vector.preimage_utf8_hex || digest!==vector.sha256) throw Error('vector mismatch: '+vector.id);
  checked++;
}
console.log(JSON.stringify({status:'passed_document_reference_only',positive_vectors_checked:checked,product_interoperability_verified:false},null,2));
