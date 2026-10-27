import socket,struct,json,sys,pathlib
ROOT=pathlib.Path('/Volumes/AIMATE_WORK/tmp/osstack/runtime/session-debt-20261026')
def rpc(method,params):
 data=json.dumps({'id':'debt','method':method,'params':params}).encode()
 with socket.socket(socket.AF_UNIX) as s:
  s.settimeout(10);s.connect('/tmp/osstack-debt-ledger.sock');s.sendall(struct.pack('>I',len(data))+data)
  def recv(n):
   b=b''
   while len(b)<n:
    c=s.recv(n-len(b))
    if not c: raise RuntimeError('incomplete frame')
    b+=c
   return b
  r=json.loads(recv(struct.unpack('>I',recv(4))[0]))
  if not r.get('ok'): raise RuntimeError(r)
  return r['result']
if __name__=='__main__':
 print(json.dumps(rpc(sys.argv[1],json.loads(sys.argv[2])),ensure_ascii=False,indent=2))
