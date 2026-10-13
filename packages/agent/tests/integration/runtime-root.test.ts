/**
 * The LoongCode runtime root: model resolution and the top-level `run()` door.
 * These exercise the composed root rather than a single concept.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { testConfig, withConfigDir } from "../../../model/src/test-support"
import { LoongCode } from "../../src/loongcode"

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loongcode-runtime-root-"))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe("Model resolution (V2)", () => {
  test("LoongCode without a configured model reports the missing dependency", async () => {
    const { dir, cleanup } = tempDir()
    const previousConfigDir = process.env.LOONGCODE_CONFIG_DIR
    process.env.LOONGCODE_CONFIG_DIR = join(dir, "config")
    try {
      const agent = new LoongCode()
      const session = agent.createSession(join(dir, "ws"))
      await expect(agent.run(session, "no model")).rejects.toThrow(/No active model/)
    } finally {
      if (previousConfigDir === undefined) delete process.env.LOONGCODE_CONFIG_DIR
      else process.env.LOONGCODE_CONFIG_DIR = previousConfigDir
    }
    cleanup()
  })
})

describe("Model lifecycle APIs", () => {
  test("updateModel replaces the configuration, persists it, and keeps the model active", async () => {
    await withConfigDir(async () => {
      const agent = new LoongCode()
      await agent.configureModel(testConfig({ id: "m1", name: "m1", contextWindow: 8_000, maxOutputTokens: 2_000 }))

      await agent.updateModel(testConfig({ id: "m1", name: "m1", contextWindow: 16_000, maxOutputTokens: 4_000 }))

      const model = await agent.currentModel()
      expect(model?.id).toBe("m1")
      expect(model?.limits).toEqual({ contextWindow: 16_000, maxOutputTokens: 4_000 })
      // Persisted, not merely cached: a fresh read of the store agrees.
      expect((await agent.modelManager()).config("m1")).toMatchObject({
        contextWindow: 16_000,
        maxOutputTokens: 4_000,
      })
    })
  })

  test("updateModel rejects an id that is not configured", async () => {
    await withConfigDir(async () => {
      const agent = new LoongCode()
      await expect(agent.updateModel(testConfig({ id: "ghost" }))).rejects.toThrow(/not configured/)
    })
  })

  test("removeModel keeps the active model when it removes another, and clears it otherwise", async () => {
    await withConfigDir(async () => {
      const agent = new LoongCode()
      await agent.configureModel(testConfig({ id: "other" }))
      await agent.configureModel(testConfig({ id: "primary" }))

      await agent.removeModel("other")
      expect((await agent.modelManager()).list().map(model => model.id)).toEqual(["primary"])
      expect((await agent.currentModel())?.id).toBe("primary")

      await agent.removeModel("primary")
      expect(await agent.currentModel()).toBeUndefined()
      expect((await agent.modelManager()).list()).toEqual([])
    })
  })

  test("removeModel reports an id that is not configured instead of swallowing it", async () => {
    await withConfigDir(async () => {
      const agent = new LoongCode()
      await expect(agent.removeModel("ghost")).rejects.toThrow(/not configured/)
    })
  })
})
