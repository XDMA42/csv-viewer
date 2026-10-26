"""把 icon.ico 和版本信息写成 Go 链接器可识别的 Windows 资源目标文件（COFF .syso）。

    python3 cmd/csvlens/winres/make_syso.py [版本号]

生成 cmd/csvlens/rsrc_windows_amd64.syso，go build 时会自动链接进 exe：
  - RT_GROUP_ICON #1（窗口与资源管理器中显示的图标，main.go 中 IconId: 1）
  - RT_VERSION #1（文件属性里的「文件说明」「产品名称」「版本」）
只依赖 Python 标准库。
"""
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'rsrc_windows_amd64.syso')

RT_ICON, RT_GROUP_ICON, RT_VERSION = 3, 14, 16
LANG_EN_US = 0x0409
LANG_ZH_CN, CP_UNICODE = 0x0804, 1200


def align(n, a=4):
    return (n + a - 1) // a * a


def read_ico(path):
    """返回 [(width, height, bit_count, image_bytes)]"""
    data = open(path, 'rb').read()
    reserved, typ, count = struct.unpack_from('<HHH', data, 0)
    if reserved != 0 or typ != 1:
        raise ValueError('不是有效的 .ico 文件')
    images = []
    for i in range(count):
        w, h, _colors, _res, _planes, bpp, size, off = struct.unpack_from('<BBBBHHII', data, 6 + 16 * i)
        images.append((w, h, bpp, data[off:off + size]))
    return images


def icon_resources(images):
    res = []
    group = struct.pack('<HHH', 0, 1, len(images))
    for i, (w, h, bpp, blob) in enumerate(images, start=1):
        res.append((RT_ICON, i, LANG_EN_US, blob))
        group += struct.pack('<BBBBHHIH', w, h, 0, 0, 1, bpp, len(blob), i)
    res.append((RT_GROUP_ICON, 1, LANG_EN_US, group))
    return res


def ver_block(key, value=b'', wtype=1, children=(), value_len=None):
    """VS_VERSIONINFO / StringFileInfo / StringTable / String / VarFileInfo / Var 的通用结构"""
    key_b = (key + '\0').encode('utf-16-le')
    head = 6 + len(key_b)
    body = b'\0' * (align(head) - head) + value
    kids = b''
    for c in children:
        kids += b'\0' * (align(len(kids)) - len(kids)) + c
    if kids:
        body += b'\0' * (align(head + len(body)) - head - len(body))
    total = head + len(body) + len(kids)
    vlen = len(value) if value_len is None else value_len
    return struct.pack('<HHH', total, vlen, wtype) + key_b + body + kids


def version_resource(version, strings):
    parts = [int(x) for x in (version.split('.') + ['0'] * 4)[:4]]
    ms, ls = parts[0] << 16 | parts[1], parts[2] << 16 | parts[3]
    fixed = struct.pack(
        '<13I',
        0xFEEF04BD, 0x00010000,  # signature, struct version
        ms, ls, ms, ls,          # file / product version
        0x3F, 0,                 # flags mask, flags
        0x00040004,              # VOS_NT_WINDOWS32
        0x1, 0,                  # VFT_APP
        0, 0)
    table = []
    for k, v in strings.items():
        val = (v + '\0').encode('utf-16-le')
        table.append(ver_block(k, val, 1, value_len=len(v) + 1))
    string_table = ver_block('%04X%04X' % (LANG_ZH_CN, CP_UNICODE), b'', 1, table)
    string_info = ver_block('StringFileInfo', b'', 1, [string_table])
    var = ver_block('Translation', struct.pack('<HH', LANG_ZH_CN, CP_UNICODE), 0)
    var_info = ver_block('VarFileInfo', b'', 1, [var])
    return ver_block('VS_VERSION_INFO', fixed, 0, [string_info, var_info])


def build_rsrc(resources):
    """生成 .rsrc 节内容（三级目录：类型 → 名称 → 语言），返回 (bytes, 需要重定位的偏移列表)"""
    tree = {}
    for typ, name, lang, blob in resources:
        tree.setdefault(typ, {}).setdefault(name, {})[lang] = blob

    def dir_size(n):
        return 16 + 8 * n

    off = dir_size(len(tree))
    type_off, name_off, entry_off, data_off = {}, {}, {}, {}
    for t in sorted(tree):
        type_off[t] = off
        off += dir_size(len(tree[t]))
    for t in sorted(tree):
        for n in sorted(tree[t]):
            name_off[t, n] = off
            off += dir_size(len(tree[t][n]))
    leaves = [(t, n, l) for t in sorted(tree) for n in sorted(tree[t]) for l in sorted(tree[t][n])]
    for k in leaves:
        entry_off[k] = off
        off += 16
    for k in leaves:
        off = align(off, 8)
        data_off[k] = off
        off += len(tree[k[0]][k[1]][k[2]])
    buf = bytearray(align(off, 8))

    def write_dir(at, entries):
        struct.pack_into('<IIHHHH', buf, at, 0, 0, 0, 0, 0, len(entries))
        for i, (ident, target, is_dir) in enumerate(entries):
            struct.pack_into('<II', buf, at + 16 + 8 * i, ident, target | (0x80000000 if is_dir else 0))

    write_dir(0, [(t, type_off[t], True) for t in sorted(tree)])
    for t in sorted(tree):
        write_dir(type_off[t], [(n, name_off[t, n], True) for n in sorted(tree[t])])
        for n in sorted(tree[t]):
            write_dir(name_off[t, n], [(l, entry_off[t, n, l], False) for l in sorted(tree[t][n])])
    relocs = []
    for k in leaves:
        blob = tree[k[0]][k[1]][k[2]]
        struct.pack_into('<IIII', buf, entry_off[k], data_off[k], len(blob), 0, 0)
        buf[data_off[k]:data_off[k] + len(blob)] = blob
        relocs.append(entry_off[k])  # OffsetToData 由链接器重定位成 RVA
    return bytes(buf), relocs


def coff(rsrc, relocs):
    ptr_raw = 20 + 40
    ptr_rel = ptr_raw + len(rsrc)
    ptr_sym = ptr_rel + 10 * len(relocs)
    file_header = struct.pack('<HHIIIHH', 0x8664, 1, 0, ptr_sym, 1, 0, 0x0004)  # AMD64, 1 节, 1 个符号
    section = struct.pack('<8sIIIIIIHHI', b'.rsrc', 0, 0, len(rsrc), ptr_raw, ptr_rel, 0, len(relocs), 0,
                          0x40000040)  # INITIALIZED_DATA | MEM_READ
    rel = b''.join(struct.pack('<IIH', r, 0, 3) for r in relocs)  # IMAGE_REL_AMD64_ADDR32NB → 符号 0
    symbol = struct.pack('<8sIhHBB', b'.rsrc', 0, 1, 0, 3, 0)  # 节符号，IMAGE_SYM_CLASS_STATIC
    strings = struct.pack('<I', 4)
    return file_header + section + rsrc + rel + symbol + strings


def main():
    version = sys.argv[1] if len(sys.argv) > 1 else '1.0.0'
    resources = icon_resources(read_ico(os.path.join(HERE, 'icon.ico')))
    resources.append((RT_VERSION, 1, LANG_EN_US, version_resource(version, {
        'FileDescription': 'CSV Lens',
        'FileVersion': version,
        'InternalName': 'CSVLens',
        'OriginalFilename': 'CSVLens.exe',
        'ProductName': 'CSV Lens',
        'ProductVersion': version,
    })))
    rsrc, relocs = build_rsrc(resources)
    with open(OUT, 'wb') as f:
        f.write(coff(rsrc, relocs))
    print('wrote', os.path.normpath(OUT), len(rsrc), 'bytes of resources,', len(relocs), 'entries')


if __name__ == '__main__':
    main()
