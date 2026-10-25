# Judging demo

The dashboard is at http://localhost:3000. Refresh once to load the stability
fix. Start it from your terminal if needed:

```bash
cd /home/mevlec/Data/devinv2
bash judge.sh
```

Keep that terminal open. This uses the current build, offline analysis and
labelled device approximations. The default Desktop scan runs one capture at a
time. The full device fleet remains selectable, but real emulators require more
RAM and are not needed for this demo.

In **Recent scans**, choose the completed `fixtures/flows` job to show all six
application states and their reproduction steps. Choose the completed
`fixtures/overflow-horizontal` job to show an overflow finding and its verified
source diff with before/after screenshots.

Saved reports also work directly while the server is running:

- [Six-state exploration](http://localhost:3000/artifacts/job-99a4f28e-c7b0-48be-81c8-4e94a0fd12c0/report.html)
- [Verified overflow repair](http://localhost:3000/artifacts/job-0cc838b0-39a7-4bb4-a9c6-cb1c377d493c/report.html)

These are actual offline runs. Live OpenAI, Windows and other Android form
factors are not part of the verified live demo.
