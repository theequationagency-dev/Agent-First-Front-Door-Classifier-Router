## What this changes

<!-- One or two sentences. What is different after this merges? -->

## Why

<!-- The problem, or the traffic you saw. Link an issue if there is one. -->

## How to check it

<!-- The command or request that shows it working. -->

```sh
npm test
```

## Checklist

- [ ] `npm test` passes
- [ ] `npm run build:check` passes (both Workers bundle)
- [ ] New behaviour has a test
- [ ] No credentials, tokens or real customer data in the diff

<!--
Touching the classifier? Say which bucket changed and what traffic moved.
Touching the booking path or the Vary handling? Those two are where a
regression is silent and expensive — please say how you tested the race.
-->
