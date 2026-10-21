"""No endpoint reads a name nothing gives it.

This exists because that shipped. A field was added to the wrong one of two
endpoints whose return statements read almost identically, and
`unresolvable_faces=unresolvable[:50]` landed in /inspect, which has no such
variable. Every import of a car through the deployed service then failed with a
500 and "NameError: name 'unresolvable' is not defined", and the only way it
was noticed was by running a real car through the live stack.

Python does not catch this: a NameError is raised when the line runs, and the
line only runs on the success path of a request against real CAD. The service
needs flask and OCC to import at all, so it cannot simply be loaded here. The
names, though, are just the syntax tree, and the tree is free.

Run: python tests/test_service_names.py
"""
import ast
import builtins
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCES = [
    ROOT / "services" / "tessellate" / "main.py",
    ROOT / "services" / "simscale-job" / "simscale_job.py",
    ROOT / "services" / "simscale-job" / "spec_mode.py",
]

failures = []
checked = 0


def bound_by(node):
    """Every name this scope binds, by any means Python has of binding one."""
    out = set()

    def args_of(fn):
        a = fn.args
        for arg in [*getattr(a, "posonlyargs", []), *a.args, *a.kwonlyargs]:
            out.add(arg.arg)
        if a.vararg:
            out.add(a.vararg.arg)
        if a.kwarg:
            out.add(a.kwarg.arg)

    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        args_of(node)

    for child in ast.walk(node):
        if isinstance(child, ast.Name) and isinstance(child.ctx, ast.Store):
            out.add(child.id)
        elif isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
            out.add(child.name)
            # A nested function's parameters are bound inside it, and the
            # walk below reaches its body, so they have to be counted too.
            if child is not node:
                args_of(child)
        elif isinstance(child, ast.ClassDef):
            out.add(child.name)
        elif isinstance(child, (ast.Import, ast.ImportFrom)):
            for alias in child.names:
                out.add((alias.asname or alias.name).split(".")[0])
        elif isinstance(child, ast.ExceptHandler) and child.name:
            out.add(child.name)
        elif isinstance(child, ast.Global):
            out.update(child.names)
        elif isinstance(child, ast.Lambda):
            # key=lambda x: x[0] binds x. Without this the sort keys in
            # match_step_ids and prepare read as unbound names.
            args_of(child)
        elif isinstance(child, (ast.comprehension,)):
            for sub in ast.walk(child.target):
                if isinstance(sub, ast.Name):
                    out.add(sub.id)
    return out


def module_scope(body):
    """Names bound at module level, and only there.

    Top-level statements only. The first version of this walked the whole tree,
    so a local inside any function counted as a global - which made the check
    pass on the exact bug it was written for, because `unresolvable` is a local
    of /prepare and /inspect was reading it. Control flow at module level is
    followed; function and class bodies are not.
    """
    out = set()
    for node in body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            out.add(node.name)
            continue
        for child in ast.walk(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                out.add(child.name)
            elif isinstance(child, ast.Name) and isinstance(child.ctx, ast.Store):
                out.add(child.id)
            elif isinstance(child, (ast.Import, ast.ImportFrom)):
                for alias in child.names:
                    out.add((alias.asname or alias.name).split(".")[0])
            elif isinstance(child, ast.ExceptHandler) and child.name:
                out.add(child.name)
    return out


for src in SOURCES:
    if not src.exists():
        failures.append(f"{src.name} is missing")
        continue
    tree = ast.parse(src.read_text(encoding="utf-8"))

    known = module_scope(tree.body) | set(dir(builtins))

    # Top-level functions only. A nested one is checked as part of its parent,
    # whose locals are in scope inside it - that is what a closure is, and
    # checking nested functions separately reported nineteen of them as reading
    # names nothing binds when every one was reading its parent's.
    for fn in tree.body:
        if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        checked += 1
        bound = bound_by(fn)
        used = {
            n.id for n in ast.walk(fn)
            if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)
        }
        unknown = sorted(used - bound - known)
        if unknown:
            failures.append(
                f"{src.name}:{fn.lineno} {fn.name}() reads "
                + ", ".join(unknown) + " and nothing binds them")

if failures:
    print(f"FAIL  {len(failures)} problem(s) across {checked} functions")
    for f in failures:
        print("   -", f)
    raise SystemExit(1)
print(f"service names: {checked} functions, every name they read is bound")
