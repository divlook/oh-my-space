---
"oh-my-space": major
---

Require Node.js `^24 || >=26`, removing support for Node 20, Node 22, and Node 25. Upgrade your Node runtime to Node 24 before installing this major OMS release; for example, run `nvm install 24` and `nvm use 24` before updating OMS.

Node 24 is the development, release, bundle, and required CI baseline. Node 26 and later are permitted, but not every future runtime is verified; the latest-runtime CI diagnostic remains separate and non-gating.

Upgrade the Changesets release tools to their current stable generation. Maintainer version preparation now requires pending Changesets: `npm run version` fails with exit code 1 for an empty release plan instead of succeeding without changes. Stable publication and the opt-in, HEAD-derived beta flow are unchanged.
