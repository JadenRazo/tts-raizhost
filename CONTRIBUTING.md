# Contributing

Small, evidence-backed fixes are welcome. Open an issue before a large architecture change.

For pull requests:

1. keep secrets, user documents, private endpoints, and live infrastructure inventory out of commits and logs
2. add or update a test for behavior changes
3. run the web, Python-contract, and manifest checks described in `README.md`
4. distinguish measured results from proposed targets or expected behavior
5. describe deployment and rollback implications; merging source is not authorization to change a live environment

Security findings follow `SECURITY.md`, not the public issue tracker.
