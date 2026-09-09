# Agent Guidance

- This project runs on Bun. Use Bun runtime features and utilities when available. Prefer them over node and external libraries.
- Write simple, elegant, easy to understand code:
  - Do not write 5 lines of code if 1 will do.
  - If an exception is unlikely to happen, do not check for it. Let it throw and bubble up.
  - If a type is only going to be used in one or two places, inline it.
- This project is early days, do not write tests. Once it takes a more mature form, we'll worry about testing.
