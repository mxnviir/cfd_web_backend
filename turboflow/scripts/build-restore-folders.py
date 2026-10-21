"""Build deployable folders that put production's original functions back.

Production's five Node functions were deployed by `firebase deploy` from one
code folder, with their settings in its .env. They went out twice from that
folder, with two different .env files: the job functions (submitSimulationJob,
refundJob, onNewJob) with PayPal sandbox settings and the PayPal functions
(createPayPalOrder, capturePayPalOrder) with live ones. The backup has both
archives exactly as deployed, so the rollback redeploys each function from the
archive it came from:

    <out>/jobs     firebase deploy --only functions:submitSimulationJob,functions:refundJob,functions:onNewJob
    <out>/paypal   firebase deploy --only functions:createPayPalOrder,functions:capturePayPalOrder

run_lap_calc is not in the new build, so the switch never touches it and the
rollback does not need to.

--rehearsal replaces every .env value except PAYPAL_ENV with a dummy, so a
rehearsal on the test project never copies production's credentials into it.

usage: python scripts/build-restore-folders.py <backup dir> <out dir> [--rehearsal]
"""
import json
import pathlib
import shutil
import sys
import zipfile

backup = pathlib.Path(sys.argv[1])
out = pathlib.Path(sys.argv[2])
rehearsal = "--rehearsal" in sys.argv

GROUPS = {
    "jobs": ("submitSimulationJob", ["submitSimulationJob", "refundJob", "onNewJob"]),
    "paypal": ("capturePayPalOrder", ["createPayPalOrder", "capturePayPalOrder"]),
}
live = {f["name"].split("/")[-1]: f for f in
        json.loads((backup / "functions" / "functions_list.json").read_text(encoding="utf-8"))}

for group, (archive_of, names) in GROUPS.items():
    # The archives of every function in a group must be the same upload.
    gens = {live[n]["buildConfig"]["source"]["storageSource"]["generation"] for n in names}
    objs = {live[n]["buildConfig"]["source"]["storageSource"]["object"] for n in names}
    src = backup / "functions" / "source" / archive_of / "source.zip"
    dest = out / group
    if dest.exists():
        shutil.rmtree(dest)
    (dest / "functions").mkdir(parents=True)
    with zipfile.ZipFile(src) as z:
        z.extractall(dest / "functions")
    (dest / "firebase.json").write_text(json.dumps({
        "functions": [{"source": "functions", "codebase": "default"}],
    }, indent=2), encoding="utf-8")
    env = dest / "functions" / ".env"
    lines = env.read_text(encoding="utf-8").splitlines()
    if rehearsal:
        lines = [l if l.startswith("PAYPAL_ENV=") or "=" not in l else l.split("=", 1)[0] + "=rehearsal-dummy"
                 for l in lines]
        env.write_text("\n".join(lines) + "\n", encoding="utf-8")
    # The settings each function was deployed with, checked against this .env.
    values = dict(l.split("=", 1) for l in lines if "=" in l)
    for n in names:
        deployed = live[n]["serviceConfig"].get("environmentVariables", {})
        match = all(deployed.get(k) == v for k, v in values.items())
        print(f"{group:6} {n:22} .env {'matches production' if match else ('dummy (rehearsal)' if rehearsal else 'DIFFERS FROM PRODUCTION')}")
    print(f"{group:6} built at {dest}  (archives: {len(objs)} object, {len(gens)} generation(s))")
    print(f"       firebase deploy --only " + ",".join(f"functions:{n}" for n in names))
