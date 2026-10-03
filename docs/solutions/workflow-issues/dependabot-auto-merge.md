---
title: Dependabot updates require manual review and merge
date: 2026-10-02
category: docs/solutions/workflow-issues
module: dependency updates
problem_type: workflow_issue
component: GitHub Actions
severity: medium
tags: [github-actions, dependabot, auto-merge, ci]
---

# Dependabot updates require manual review and merge

The former `pull_request_target` workflow enabled squash auto-merge for every Dependabot PR. It did not execute PR code or bypass protection, but `--auto` could merge immediately because the repository ruleset required neither checks nor approving reviews.

The auto-merge workflow has been removed. Dependabot still opens PRs; review dependency changes and run `npm run build` and `npm run test:unit` before merging. Do not restore automated merging until enforced validation and review requirements are in place. Tests cannot by themselves establish that dependency code is non-malicious.
