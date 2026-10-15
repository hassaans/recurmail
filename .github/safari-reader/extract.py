"""Pull Safari's Reader detection JavaScript (and the shared helpers it needs)
out of the system's shared library cache, where it is embedded as text.
Writes the combined source to a temporary file; nothing is committed."""
import pathlib, re, sys

def block_around(data: bytes, index: int) -> bytes:
    # Embedded sources are NUL-terminated C strings and may contain UTF-8.
    start = data.rfind(b"\0", 0, index) + 1
    end = data.find(b"\0", index)
    return data[start:end if end != -1 else len(data)]


hits = [l.strip() for l in open(sys.argv[1]) if l.strip()]
blocks: dict[str, bytes] = {}
for path in hits:
    data = pathlib.Path(path).read_bytes()
    for m in re.finditer(rb"//# sourceURL=(__InjectedScript_[A-Za-z0-9_]+\.js)", data):
        name = m.group(1).decode()
        chunk = block_around(data, m.start())
        if len(chunk) > len(blocks.get(name, b"")):
            blocks[name] = chunk
reader_names = sorted(n for n in blocks if "Reader" in n)
print("reader-related scripts:", {n: len(blocks[n]) for n in reader_names})


def defines(chunk: bytes) -> set[bytes]:
    names = set(re.findall(rb"(?:function|class)\s+([A-Za-z_$][\w$]*)", chunk))
    names |= set(re.findall(rb"(?:^|[;{}\s])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=", chunk))
    return names


def uses(chunk: bytes) -> set[bytes]:
    return set(re.findall(rb"\b([A-Z][\w$]*|[a-z][\w$]*)\s*[\(\.]", chunk)) | set(re.findall(rb"new\s+([A-Za-z_$][\w$]*)", chunk))


finder_name = "__InjectedScript_ReaderArticleFinder.js"
order = [finder_name]
defined = defines(blocks[finder_name])
for _ in range(4):
    missing = set().union(*(uses(blocks[n]) for n in order)) - defined
    added = False
    for name in reader_names:
        if name in order:
            continue
        provides = sorted(n.decode() for n in missing & defines(blocks[name]))
        if provides:
            print("helper", name, "provides", provides[:15])
            order.insert(0, name)
            defined |= defines(blocks[name])
            added = True
    if not added:
        break
print("load order:", order)
pathlib.Path(sys.argv[2]).write_bytes(b"\n;\n".join(blocks[n] for n in order))
