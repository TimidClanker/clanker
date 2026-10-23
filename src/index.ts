// Dispatch before importing application bootstrap: works with source and bun --compile.
if (import.meta.main) {
  if (process.argv[2] === 'status') {
    const { statusCli } = await import('./status/cli')
    process.exitCode = await statusCli(process.argv.slice(3))
  } else {
    const { main } = await import('./main')
    main().then(
      () => process.exit(0),
      error => {
        console.error('[clanker]', error)
        process.exit(1)
      }
    )
  }
}
