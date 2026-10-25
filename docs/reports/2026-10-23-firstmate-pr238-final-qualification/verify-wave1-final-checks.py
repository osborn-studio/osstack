import json,pathlib
r=pathlib.Path("/Volumes/AIMATE_WORK/tmp/osstack/smoke/pr237-integration")
x=json.loads((r/"wave1-final-checks.json").read_text())
assert len(x)==8 and all(c["exit_code"]==0 for c in x)
print("All eight local qualification stages passed; remote CI and independent approval remain separate.")
