type ExitProvenConnection = {
  close: () => Promise<boolean>
}

export async function cancelProcessAcquisition(input: {
  cancel: () => void
  connection: () => ExitProvenConnection | null
  exitProven: () => boolean
  markExitProven: () => void
  finished: Promise<void>
}): Promise<boolean> {
  input.cancel()
  const connectionBeforeFinish = input.connection()
  if (connectionBeforeFinish) {
    if ((await connectionBeforeFinish.close()) !== true) {
      return false
    }
    input.markExitProven()
  }
  await input.finished
  if (input.exitProven()) {
    return true
  }
  const connectionAfterFinish = input.connection()
  if (!connectionAfterFinish || connectionAfterFinish === connectionBeforeFinish) {
    return true
  }
  if ((await connectionAfterFinish.close()) !== true) {
    return false
  }
  input.markExitProven()
  return true
}
