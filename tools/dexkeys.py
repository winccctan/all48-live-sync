import struct, glob, re, sys

DEX = sorted(glob.glob('/tmp/p607/classes*.dex'))

def uleb(b, o):
    r = 0; s = 0
    while True:
        x = b[o]; o += 1
        r |= (x & 0x7f) << s
        if not x & 0x80:
            return r, o
        s += 7

def load(f):
    b = open(f, 'rb').read()
    (strsz, stroff, typesz, typeoff, protosz, protooff,
     fieldsz, fieldoff, msz, moff, cdsz, cdoff) = struct.unpack_from('<12I', b, 0x38)
    strings = []
    for i in range(strsz):
        o = struct.unpack_from('<I', b, stroff + 4 * i)[0]
        n, p = uleb(b, o)
        strings.append(b[p:p + n].decode('utf-8', 'ignore'))
    types = [strings[struct.unpack_from('<I', b, typeoff + 4 * i)[0]] for i in range(typesz)]
    return b, strings, types, moff, cdoff, cdsz

targets = set(sys.argv[1].split(','))
MAXLEN = int(sys.argv[2]) if len(sys.argv) > 2 else 400

for f in DEX:
    b, strings, types, moff, cdoff, cdsz = load(f)
    tset = {i for i, s in enumerate(strings) if s in targets}
    if not tset:
        continue
    for ci in range(cdsz):
        base = cdoff + 32 * ci
        cidx = struct.unpack_from('<I', b, base)[0]
        cd = struct.unpack_from('<I', b, base + 24)[0]
        cname = types[cidx]
        if cd == 0:
            continue
        o = cd
        sf, o = uleb(b, o); inf, o = uleb(b, o)
        for _ in range(sf + inf):
            _, o = uleb(b, o); _, o = uleb(b, o)
        dm, o = uleb(b, o); vm, o = uleb(b, o)
        for grp, cnt in ((0, dm), (1, vm)):
            midx = 0
            for _ in range(cnt):
                d, o = uleb(b, o); midx += d
                a, o = uleb(b, o)
                co, o = uleb(b, o)
                if co == 0:
                    continue
                regs, ins, outs, tries, dbg, isz = struct.unpack_from('<4H2I', b, co)
                if co + 16 + 2 * isz > len(b):
                    continue
                p = co + 16
                found = []
                for k in range(isz):
                    u = struct.unpack_from('<H', b, p + 2 * k)[0]
                    if u == 0x1a and k + 1 < isz:
                        si = struct.unpack_from('<H', b, p + 2 * (k + 1))[0]
                        if si < len(strings):
                            found.append(strings[si])
                    elif u == 0x1b and k + 2 < isz:
                        lo = struct.unpack_from('<H', b, p + 2 * (k + 1))[0]
                        hi = struct.unpack_from('<H', b, p + 2 * (k + 2))[0]
                        si = lo | (hi << 16)
                        if si < len(strings):
                            found.append(strings[si])
                if any(x in targets for x in found):
                    mn = strings[struct.unpack_from('<HHI', b, moff + 8 * midx)[2]]
                    print('====', cname, '->', mn)
                    for s in found:
                        print('   ', repr(s[:120]))
