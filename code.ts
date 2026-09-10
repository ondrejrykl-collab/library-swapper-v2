// Library Swapper v2 — main plugin logic
// Data maps extracted to separate files for readability:
//   FULL_MAP  → data/full-map.json   (component name → {key, type, lib})
//   EXCLUDE_KEYS → data/exclude-keys.json  (component keys to skip)
//
// In the compiled Figma plugin, both are inlined as:
//   const FULL_MAP: Record<string, {key:string; type:string; lib:string}> = { ... }
//   const EXCLUDE_KEYS = new Set<string>([ ... ])

const TOOL_ID = 'library-swapper-v2'
const DISPLAY_NAME = 'Library swapper v2'

figma.root.setRelaunchData({ [TOOL_ID]: DISPLAY_NAME })
figma.showUI(__html__, { width: 420, height: 520 })


const NEW_LIB_KEYS = new Set<string>()
for (const entry of Object.values(FULL_MAP)) {
  NEW_LIB_KEYS.add(entry.key)
}

function findMatch(lookupName: string, compName: string): { matchedName: string; key: string; type: string; lib: string } | null {
  const candidates: string[] = [lookupName, compName]
  for (const base of [lookupName, compName]) {
    const stripped = base.replace(/^base\//, '')
    candidates.push(stripped)
    const parts = stripped.split('/')
    const last = parts[parts.length - 1]
    if (!last.startsWith('--')) {
      parts[parts.length - 1] = '--' + last
      candidates.push(parts.join('/'))
    }
    candidates.push('--' + last, last)
    const dashed = last.replace(/ /g, '-')
    candidates.push('--' + dashed, dashed)
  }
  for (const c of candidates) {
    if (FULL_MAP[c]) return { matchedName: c, ...FULL_MAP[c] }
  }
  return null
}

interface SwapResult {
  nodeId: string
  nodeName: string
  componentName: string
  status: 'swapped' | 'skipped' | 'error' | 'already-new'
  newName?: string
  reason?: string
  debug?: string
}

// ── DEEP OVERRIDE SNAPSHOT ──
// Strip "#nodeId" suffix from component property keys for cross-version matching
function propBaseName(key: string): string {
  const hash = key.indexOf('#')
  return hash >= 0 ? key.substring(0, hash) : key
}

interface TextOverrideEntry {
  path: string
  name: string
  text: string
  consumed: boolean
}

interface OverrideSnapshot {
  // Component properties by base name (stripped of #id)
  compProps: Map<string, { type: string; value: unknown }>
  // Instance swap properties: base name → { name, key, csKey? } for cross-library + direct-import matching
  instanceSwaps: Map<string, { name: string; key: string; csKey: string | null }>
  // Text content by relative path within instance
  textByPath: Map<string, string>
  // Ordered list of ALL text overrides (for suffix + indexed matching)
  textEntries: TextOverrideEntry[]
  // Debug log
  debugLog: string[]
}

function getNodePath(node: SceneNode, root: SceneNode): string {
  const parts: string[] = []
  let cur: BaseNode | null = node
  while (cur && cur !== root) {
    parts.unshift(cur.name)
    cur = cur.parent
  }
  return parts.join('/')
}

// Deep-collect overrides from an instance and all its nested instances
async function collectOverrides(inst: InstanceNode): Promise<OverrideSnapshot> {
  const snap: OverrideSnapshot = {
    compProps: new Map(),
    instanceSwaps: new Map(),
    textByPath: new Map(),
    textEntries: [],
    debugLog: [],
  }

  // Collect component properties from this instance AND all nested instances
  async function collectCompProps(node: InstanceNode, pathPrefix: string) {
    const props = node.componentProperties
    for (const [key, val] of Object.entries(props)) {
      const baseName = propBaseName(key)
      const fullKey = pathPrefix ? pathPrefix + '/' + baseName : baseName
      if (val.type === 'BOOLEAN' || val.type === 'TEXT' || (val.type === 'VARIANT' && pathPrefix !== '')) {
        // Collect BOOLEAN, TEXT, and VARIANT (for nested instances only — top-level variant is handled by findBestVariant)
        snap.compProps.set(fullKey, { type: val.type, value: val.value })
        if (!snap.compProps.has(baseName)) {
          snap.compProps.set(baseName, { type: val.type, value: val.value })
        }
      } else if (val.type === 'INSTANCE_SWAP') {
        // Resolve the node ID to component name + key for cross-library + direct-import matching
        try {
          const swapNode = await figma.getNodeByIdAsync(val.value as string)
          if (swapNode && (swapNode.type === 'COMPONENT' || swapNode.type === 'COMPONENT_SET')) {
            const swapName = swapNode.parent?.type === 'COMPONENT_SET'
              ? swapNode.parent.name
              : swapNode.name
            const swapKey = (swapNode as ComponentNode).key
            const swapCsKey = swapNode.parent?.type === 'COMPONENT_SET'
              ? (swapNode.parent as ComponentSetNode).key
              : null
            const info = { name: swapName, key: swapKey, csKey: swapCsKey }
            snap.debugLog.push('COLLECT SWAP: key=' + baseName + ' → name=' + swapName + ' compKey=' + swapKey + (swapCsKey ? ' csKey=' + swapCsKey : ''))
            snap.instanceSwaps.set(fullKey, info)
            if (!snap.instanceSwaps.has(baseName)) {
              snap.instanceSwaps.set(baseName, info)
            }
          } else {
            snap.debugLog.push('COLLECT SWAP: key=' + baseName + ' → node NOT FOUND or not component for id=' + (val.value as string))
          }
        } catch { /* node not found */ }
      }
    }
    // Recurse into nested instances
    if ('children' in node) {
      for (const child of (node as ChildrenMixin).children) {
        if (child.type === 'INSTANCE') {
          await collectCompProps(child as InstanceNode, pathPrefix ? pathPrefix + '/' + child.name : child.name)
        }
      }
    }
  }
  await collectCompProps(inst, '')

  // Collect ALL text content from ALL text nodes (not just overrides)
  // This captures text even when override IDs don't match descendants
  // (happens when internal component structure was restructured)
  const allTextNodes = (inst as ChildrenMixin).findAll(n => n.type === 'TEXT') as TextNode[]
  for (const textNode of allTextNodes) {
    const path = getNodePath(textNode as SceneNode, inst)
    const text = textNode.characters
    snap.textByPath.set(path, text)
    snap.textEntries.push({ path, name: textNode.name, text, consumed: false })
    snap.debugLog.push('COLLECT TEXT: path=' + path + ' name=' + textNode.name + ' text="' + text + '"')
  }

  return snap
}

// Restore component properties after swap
async function restoreCompProps(inst: InstanceNode, snap: OverrideSnapshot): Promise<number> {
  let restored = 0

  async function applyToInstance(node: InstanceNode, pathPrefix: string) {
    const props = node.componentProperties

    for (const [key, val] of Object.entries(props)) {
      const baseName = propBaseName(key)
      const fullKey = pathPrefix ? pathPrefix + '/' + baseName : baseName

      if (val.type === 'BOOLEAN' || val.type === 'TEXT' || val.type === 'VARIANT') {
        const saved = snap.compProps.get(fullKey) || snap.compProps.get(baseName)
        if (saved && saved.value !== val.value) {
          try {
            node.setProperties({ [key]: saved.value as string | boolean })
            restored++
            snap.debugLog.push('RESTORE PROP: ' + baseName + '=' + JSON.stringify(saved.value) + ' (was ' + JSON.stringify(val.value) + ') type=' + val.type)
          } catch (e) {
            snap.debugLog.push('RESTORE PROP FAIL: ' + baseName + ' err=' + (e instanceof Error ? e.message : String(e)))
          }
        }
      } else if (val.type === 'INSTANCE_SWAP') {
        // Restore instance swap by matching component name or direct key import
        const savedInfo = snap.instanceSwaps.get(fullKey) || snap.instanceSwaps.get(baseName)
        if (!savedInfo) {
          snap.debugLog.push('RESTORE SWAP SKIP: key=' + baseName + ' → no saved info found')
          continue
        }
        const savedName = savedInfo.name

        // Check if the current swap target already matches
        try {
          const currentTarget = await figma.getNodeByIdAsync(val.value as string)
          if (currentTarget) {
            const currentName = currentTarget.parent?.type === 'COMPONENT_SET'
              ? currentTarget.parent.name
              : currentTarget.name
            if (currentName === savedName) {
              snap.debugLog.push('RESTORE SWAP SKIP: key=' + baseName + ' → already correct: ' + currentName)
              continue
            }
            snap.debugLog.push('RESTORE SWAP: key=' + baseName + ' current=' + currentName + ' saved=' + savedName)
          }
        } catch { /* ignore */ }

        // Strategy 1: Look up saved component name in FULL_MAP (with fuzzy matching)
        let matched = false
        const mapMatch = findMatch(savedName, savedName)
        if (mapMatch) {
          snap.debugLog.push('RESTORE SWAP S1: findMatch("' + savedName + '") → ' + mapMatch.matchedName + ' key=' + mapMatch.key)
          try {
            if (mapMatch.type === 'COMPONENT_SET') {
              const cs = await figma.importComponentSetByKeyAsync(mapMatch.key)
              const defaultChild = (cs.defaultVariant || cs.children[0]) as ComponentNode
              node.setProperties({ [key]: defaultChild.id })
              restored++
              matched = true
              snap.debugLog.push('RESTORE SWAP S1 OK: set to ' + defaultChild.name + ' (from CS ' + cs.name + ')')
            } else {
              const comp = await figma.importComponentByKeyAsync(mapMatch.key)
              node.setProperties({ [key]: comp.id })
              restored++
              matched = true
              snap.debugLog.push('RESTORE SWAP S1 OK: set to ' + comp.name)
            }
          } catch (e) {
            snap.debugLog.push('RESTORE SWAP S1 FAIL: ' + (e instanceof Error ? e.message : String(e)))
          }
        } else {
          snap.debugLog.push('RESTORE SWAP S1: findMatch("' + savedName + '") → NO MATCH in FULL_MAP')
        }

        // Strategy 2: Search preferred values from mainComponent's property definitions
        if (!matched) {
          try {
            const mc = await node.getMainComponentAsync()
            if (mc) {
              const defSource = mc.parent?.type === 'COMPONENT_SET' ? mc.parent as ComponentSetNode : mc
              const propDefs = defSource.componentPropertyDefinitions
              const def = propDefs[key]
              if (def && 'preferredValues' in def) {
                const preferred = (def as { preferredValues: Array<{ type: string; key: string }> }).preferredValues || []
                snap.debugLog.push('RESTORE SWAP S2: checking ' + preferred.length + ' preferred values for "' + savedName + '"')
                for (const pv of preferred) {
                  if (pv.type === 'COMPONENT' || pv.type === 'COMPONENT_SET') {
                    try {
                      const comp = pv.type === 'COMPONENT_SET'
                        ? await figma.importComponentSetByKeyAsync(pv.key)
                        : await figma.importComponentByKeyAsync(pv.key)
                      if (comp.name === savedName || findMatch(savedName, comp.name)) {
                        const targetId = comp.type === 'COMPONENT_SET'
                          ? ((comp as ComponentSetNode).defaultVariant || (comp as ComponentSetNode).children[0]).id
                          : comp.id
                        node.setProperties({ [key]: targetId })
                        restored++
                        matched = true
                        snap.debugLog.push('RESTORE SWAP S2 OK: matched preferred ' + comp.name)
                        break
                      }
                    } catch { /* import failed */ }
                  }
                }
                if (!matched) snap.debugLog.push('RESTORE SWAP S2: no preferred value matched "' + savedName + '"')
              } else {
                snap.debugLog.push('RESTORE SWAP S2: no preferredValues for key=' + key)
              }
            }
          } catch (e) {
            snap.debugLog.push('RESTORE SWAP S2 FAIL: ' + (e instanceof Error ? e.message : String(e)))
          }
        }

        // Strategy 3: Direct re-import by original component key
        // Handles icons and other components not in FULL_MAP but still valid in their library
        if (!matched && savedInfo.key) {
          snap.debugLog.push('RESTORE SWAP S3: trying direct import by key=' + savedInfo.key)
          try {
            const comp = await figma.importComponentByKeyAsync(savedInfo.key)
            node.setProperties({ [key]: comp.id })
            restored++
            matched = true
            snap.debugLog.push('RESTORE SWAP S3 OK: imported ' + comp.name + ' by key')
          } catch (e) {
            snap.debugLog.push('RESTORE SWAP S3 FAIL: ' + (e instanceof Error ? e.message : String(e)))
            // Try component set key if available
            if (savedInfo.csKey) {
              try {
                const cs = await figma.importComponentSetByKeyAsync(savedInfo.csKey)
                const defaultChild = (cs.defaultVariant || cs.children[0]) as ComponentNode
                node.setProperties({ [key]: defaultChild.id })
                restored++
                matched = true
                snap.debugLog.push('RESTORE SWAP S3 OK: imported CS ' + cs.name + ' default variant by csKey')
              } catch (e2) {
                snap.debugLog.push('RESTORE SWAP S3 CS FAIL: ' + (e2 instanceof Error ? e2.message : String(e2)))
              }
            }
          }
        }

        if (!matched) {
          snap.debugLog.push('RESTORE SWAP FAILED: all strategies exhausted for ' + baseName + '=' + savedName)
        }
      }
    }

    // Recurse into nested instances
    if ('children' in node) {
      for (const child of (node as ChildrenMixin).children) {
        if (child.type === 'INSTANCE') {
          await applyToInstance(child as InstanceNode, pathPrefix ? pathPrefix + '/' + child.name : child.name)
        }
      }
    }
  }
  await applyToInstance(inst, '')
  return restored
}

// Get path suffix (last N segments)
function pathSuffix(path: string, n: number): string {
  const parts = path.split('/')
  return parts.slice(-n).join('/')
}

// Restore text overrides after swap using multi-level matching
async function restoreTextOverrides(inst: InstanceNode, snap: OverrideSnapshot): Promise<number> {
  if (snap.textEntries.length === 0) return 0
  let restored = 0
  const textNodes = (inst as ChildrenMixin).findAll(n => n.type === 'TEXT') as TextNode[]

  // Reset consumed flags
  for (const entry of snap.textEntries) entry.consumed = false

  for (const textNode of textNodes) {
    const path = getNodePath(textNode as SceneNode, inst)
    let matchedEntry: TextOverrideEntry | null = null

    // Strategy 1: Exact full path match
    for (const entry of snap.textEntries) {
      if (!entry.consumed && entry.path === path) {
        matchedEntry = entry
        break
      }
    }

    // Strategy 2: Suffix path matching (last 2, 3, 4 segments)
    if (!matchedEntry) {
      for (let suffixLen = 2; suffixLen <= 5; suffixLen++) {
        const targetSuffix = pathSuffix(path, suffixLen)
        const candidates = snap.textEntries.filter(e => !e.consumed && pathSuffix(e.path, suffixLen) === targetSuffix)
        if (candidates.length === 1) {
          matchedEntry = candidates[0]
          break
        }
      }
    }

    // Strategy 3: First unconsumed entry with same name
    // (after earlier strategies consumed some entries, indices may be misaligned,
    //  so just take the first available match by name)
    if (!matchedEntry) {
      for (const entry of snap.textEntries) {
        if (!entry.consumed && entry.name === textNode.name) {
          matchedEntry = entry
          break
        }
      }
    }

    if (matchedEntry) {
      snap.debugLog.push('TEXT MATCH: node="' + textNode.name + '" newPath=' + path + ' ← oldPath=' + matchedEntry.path + ' saved="' + matchedEntry.text + '" current="' + textNode.characters + '"')
      if (matchedEntry.text !== textNode.characters) {
        try {
          const len = textNode.characters.length
          if (len > 0) {
            const fonts = textNode.getRangeAllFontNames(0, len)
            for (const font of fonts) {
              await figma.loadFontAsync(font)
            }
          } else if (textNode.fontName !== figma.mixed) {
            await figma.loadFontAsync(textNode.fontName as FontName)
          }
          textNode.characters = matchedEntry.text
          matchedEntry.consumed = true
          restored++
          snap.debugLog.push('RESTORE TEXT OK: "' + textNode.name + '" → "' + matchedEntry.text + '"')
        } catch (e) {
          snap.debugLog.push('RESTORE TEXT FAIL: "' + textNode.name + '" err=' + (e instanceof Error ? e.message : String(e)))
        }
      } else {
        matchedEntry.consumed = true
        snap.debugLog.push('RESTORE TEXT SKIP: already correct')
      }
    } else {
      snap.debugLog.push('TEXT NO MATCH: node="' + textNode.name + '" path=' + path + ' current="' + textNode.characters + '"')
    }
  }
  return restored
}

// ── SMART VARIANT MATCHING ──
// Find the best matching variant in a ComponentSet, considering property overlap
function findBestVariant(cs: ComponentSetNode, oldVariantName: string): ComponentNode {
  // Parse variant props from name like "Variant=Default, Solid=False"
  const oldProps = new Map<string, string>()
  for (const part of oldVariantName.split(',')) {
    const [k, v] = part.trim().split('=')
    if (k && v) oldProps.set(k.trim(), v.trim())
  }

  // Exact match first
  const exact = cs.children.find(c => c.name === oldVariantName) as ComponentNode | undefined
  if (exact) return exact

  // Score each variant by how many properties match
  let bestScore = -1
  let bestVariant: ComponentNode | null = null
  for (const child of cs.children) {
    if (child.type !== 'COMPONENT') continue
    const childProps = new Map<string, string>()
    for (const part of child.name.split(',')) {
      const [k, v] = part.trim().split('=')
      if (k && v) childProps.set(k.trim(), v.trim())
    }
    let score = 0
    let mismatches = 0
    for (const [k, v] of oldProps) {
      if (childProps.has(k)) {
        if (childProps.get(k) === v) score += 2
        else mismatches++
      }
      // Property not present in new variant = neutral (don't penalize)
    }
    // Penalize extra properties in new variant that weren't in old
    for (const k of childProps.keys()) {
      if (!oldProps.has(k)) mismatches++
    }
    const finalScore = score - mismatches
    if (finalScore > bestScore) {
      bestScore = finalScore
      bestVariant = child as ComponentNode
    }
  }

  return bestVariant || (cs.defaultVariant || cs.children[0]) as ComponentNode
}

// ── SCAN AND SWAP (multi-pass, with deep override preservation) ──
async function scanAndSwap(rootNodes: readonly SceneNode[], dryRun: boolean): Promise<SwapResult[]> {
  const results: SwapResult[] = []
  const instances: InstanceNode[] = []

  for (const node of rootNodes) {
    if (node.type === 'INSTANCE') instances.push(node)
    if ('findAll' in node) {
      const found = (node as ChildrenMixin).findAll(n => n.type === 'INSTANCE') as InstanceNode[]
      instances.push(...found)
    }
  }

  figma.ui.postMessage({ type: 'progress', count: 0, total: instances.length, phase: 'Scanning' })

  interface McInfo {
    mcKey: string
    csKey: string | null
    compName: string
    variantName: string
    remote: boolean
    verdict: 'new' | 'needs-update' | 'exclude' | 'local' | { matchedName: string; key: string; type: string; lib: string } | 'no-match'
  }
  const mcCache = new Map<string, McInfo>()

  interface InstInfo { inst: InstanceNode; info: McInfo }
  const swappable: InstInfo[] = []
  const swappableIds = new Set<string>()
  const BATCH = 100

  for (let i = 0; i < instances.length; i++) {
    const inst = instances[i]
    const mc = await inst.getMainComponentAsync()
    if (!mc) continue

    const cacheKey = mc.key
    let info = mcCache.get(cacheKey)
    if (!info) {
      const parent = mc.parent
      const csKey = parent?.type === 'COMPONENT_SET' ? (parent as ComponentSetNode).key : null
      const mcKey = mc.key
      const effectiveKey = csKey || mcKey
      const csName = parent?.type === 'COMPONENT_SET' ? (parent as ComponentSetNode).name : null
      const compName = csName || mc.name

      let verdict: McInfo['verdict']
      if (!mc.remote) {
        verdict = 'local'
      } else if (EXCLUDE_KEYS.has(mcKey) || (csKey && EXCLUDE_KEYS.has(csKey))) {
        verdict = 'exclude'
      } else if (NEW_LIB_KEYS.has(effectiveKey) || NEW_LIB_KEYS.has(mcKey)) {
        // Component key is in the new library — needs re-import to force update
        verdict = 'needs-update'
      } else {
        // Try matching with current name first
        let match = findMatch(compName, mc.name)

        // If no match, try re-importing to get the LATEST published name
        // (the deprecated library may have renamed the component)
        if (!match) {
          try {
            let latestName: string | null = null
            if (csKey) {
              const latestCS = await figma.importComponentSetByKeyAsync(csKey)
              latestName = latestCS.name
            } else {
              const latestComp = await figma.importComponentByKeyAsync(mcKey)
              latestName = latestComp.parent?.type === 'COMPONENT_SET'
                ? latestComp.parent.name
                : latestComp.name
            }
            if (latestName && latestName !== compName) {
              match = findMatch(latestName, latestName)
            }
          } catch { /* import failed — leave as no-match */ }
        }

        verdict = match || 'no-match'
      }

      info = { mcKey, csKey, compName, variantName: mc.name, remote: mc.remote, verdict }
      mcCache.set(cacheKey, info)
    }

    if (info.verdict === 'needs-update') {
      swappable.push({ inst, info })
      swappableIds.add(inst.id)
    } else if (info.verdict === 'local' || info.verdict === 'exclude') {
      // skip
    } else if (info.verdict === 'no-match') {
      swappable.push({ inst, info })
    } else {
      swappable.push({ inst, info })
      swappableIds.add(inst.id)
    }

    if ((i + 1) % BATCH === 0) {
      figma.ui.postMessage({ type: 'progress', count: i + 1, total: instances.length, phase: 'Scanning' })
      await new Promise(r => setTimeout(r, 0))
    }
  }

  // Filter: skip ancestor-swapped/updated instances, separate no-match
  const jobs: InstInfo[] = []
  for (const item of swappable) {
    const v = item.info.verdict
    if (v === 'no-match') {
      // Check if ancestor will be updated — if so, skip silently
      let ancestorUpdated = false
      let cur: BaseNode | null = item.inst.parent
      while (cur && cur.type !== 'PAGE' && cur.type !== 'DOCUMENT') {
        if (cur.type === 'INSTANCE' && swappableIds.has(cur.id)) {
          ancestorUpdated = true
          break
        }
        cur = cur.parent
      }
      if (!ancestorUpdated) {
        results.push({ nodeId: item.inst.id, nodeName: item.inst.name, componentName: item.info.compName, status: 'skipped', reason: 'No match in new libraries' })
      }
      continue
    }
    let ancestorSwapped = false
    let cur2: BaseNode | null = item.inst.parent
    while (cur2 && cur2.type !== 'PAGE' && cur2.type !== 'DOCUMENT') {
      if (cur2.type === 'INSTANCE' && swappableIds.has(cur2.id)) {
        ancestorSwapped = true
        break
      }
      cur2 = cur2.parent
    }
    if (ancestorSwapped) continue
    jobs.push(item)
  }

  // Import phase
  figma.ui.postMessage({ type: 'progress', count: 0, total: jobs.length, phase: 'Importing' })
  const importCache = new Map<string, ComponentNode>()
  const csImportCache = new Map<string, ComponentSetNode>()

  if (!dryRun) {
    const uniqueKeys = new Map<string, { key: string; type: string }>()
    for (const job of jobs) {
      const m = job.info.verdict as { key: string; type: string }
      if (!uniqueKeys.has(m.key)) uniqueKeys.set(m.key, { key: m.key, type: m.type })
    }
    let importIdx = 0
    for (const [key, entry] of uniqueKeys) {
      try {
        if (entry.type === 'COMPONENT_SET') {
          csImportCache.set(key, await figma.importComponentSetByKeyAsync(key))
        } else {
          importCache.set(key, await figma.importComponentByKeyAsync(key))
        }
      } catch { /* will fail per-instance later */ }
      importIdx++
      if (importIdx % 3 === 0) {
        figma.ui.postMessage({ type: 'progress', count: 0, total: jobs.length, phase: 'Importing ' + importIdx + '/' + uniqueKeys.size })
        await new Promise(r => setTimeout(r, 0))
      }
    }
  }

  // Swap phase
  const SWAP_BATCH = 20
  let progress = 0
  for (const job of jobs) {

    // ── NEEDS-UPDATE: re-import latest published version and re-swap ──
    if (job.info.verdict === 'needs-update') {
      if (dryRun) {
        results.push({ nodeId: job.inst.id, nodeName: job.inst.name, componentName: job.info.compName, status: 'swapped', newName: job.info.compName + ' (update)' })
      } else {
        try {
          let target: ComponentNode
          if (job.info.csKey) {
            const cs = await figma.importComponentSetByKeyAsync(job.info.csKey)
            target = findBestVariant(cs, job.info.variantName)
          } else {
            target = await figma.importComponentByKeyAsync(job.info.mcKey)
          }
          // swapComponent triggers Figma's native name-matching override preservation
          job.inst.swapComponent(target)
          results.push({ nodeId: job.inst.id, nodeName: job.inst.name, componentName: job.info.compName, status: 'swapped', newName: job.info.compName + ' (updated)' })
        } catch (e) {
          results.push({ nodeId: job.inst.id, nodeName: job.inst.name, componentName: job.info.compName, status: 'error', reason: e instanceof Error ? e.message : String(e) })
        }
      }
    } else {
    // ── CROSS-LIBRARY SWAP ──
    const match = job.info.verdict as { matchedName: string; key: string; type: string; lib: string }

    if (dryRun) {
      results.push({ nodeId: job.inst.id, nodeName: job.inst.name, componentName: job.info.compName, status: 'swapped', newName: match.matchedName + ' (' + match.lib + ')' })
    } else {
      try {
        // 1. SAVE all overrides BEFORE swap
        const snap = await collectOverrides(job.inst)

        // 2. Find target in new library (single swap, no Phase 1)
        let target: ComponentNode
        if (match.type === 'COMPONENT_SET') {
          const cs = csImportCache.get(match.key)
          if (!cs) throw new Error('Import failed')
          target = findBestVariant(cs, job.info.variantName)
        } else {
          const comp = importCache.get(match.key)
          if (!comp) throw new Error('Import failed')
          target = comp
        }

        // 3. Single swap to new library
        job.inst.swapComponent(target)

        // 4. RESTORE component properties (boolean toggles, text props, instance swaps)
        const propsRestored = await restoreCompProps(job.inst, snap)

        // 5. RESTORE text overrides
        const textRestored = await restoreTextOverrides(job.inst, snap)

        const parts: string[] = []
        if (propsRestored > 0) parts.push(propsRestored + ' props')
        if (textRestored > 0) parts.push(textRestored + ' text')
        const suffix = parts.length > 0 ? ' +restored ' + parts.join(', ') : ''

        results.push({ nodeId: job.inst.id, nodeName: job.inst.name, componentName: job.info.compName, status: 'swapped', newName: match.matchedName + ' (' + match.lib + ')' + suffix, debug: snap.debugLog.join(' | ') })
      } catch (e) {
        results.push({ nodeId: job.inst.id, nodeName: job.inst.name, componentName: job.info.compName, status: 'error', reason: e instanceof Error ? e.message : String(e) })
      }
    }
    } // end else (cross-library swap)

    progress++
    if (progress % SWAP_BATCH === 0) {
      figma.ui.postMessage({ type: 'progress', count: progress, total: jobs.length, phase: 'Swapping' })
      await new Promise(r => setTimeout(r, 0))
    }
  }

  return results
}

// ── MESSAGE HANDLER ──
figma.ui.onmessage = async (msg: { type: string; [k: string]: unknown }) => {
  if (msg.type === 'resize') {
    figma.ui.resize(420, Math.max(120, Math.min(900, Math.round(msg.height as number))))
    return
  }

  if (msg.type === 'run') {
    const dryRun = msg.dryRun === true
    const scope = (msg.scope as string) || 'selection'

    let roots: readonly SceneNode[] = []
    if (scope === 'selection') {
      roots = figma.currentPage.selection
      if (roots.length === 0) {
        figma.notify('Select at least one frame first', { error: true })
        figma.ui.postMessage({ type: 'error', message: 'No selection. Select a frame first.' })
        return
      }
    } else {
      roots = figma.currentPage.children
    }

    figma.ui.postMessage({ type: 'running', dryRun })

    // Multi-pass swap
    let allResults: SwapResult[] = []
    const MAX_PASSES = 10
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const passResults = await scanAndSwap(roots, dryRun)
      allResults = allResults.concat(passResults)
      const swappedThisPass = passResults.filter(r => r.status === 'swapped').length
      if (swappedThisPass === 0) break
      if (dryRun) break
      figma.ui.postMessage({ type: 'progress', count: 0, total: 0, phase: 'Re-scanning (pass ' + (pass + 2) + ')' })
    }

    const resultMap = new Map<string, SwapResult>()
    for (const r of allResults) resultMap.set(r.nodeId, r)
    const results = Array.from(resultMap.values())

    const swapped = results.filter(r => r.status === 'swapped')
    const skipped = results.filter(r => r.status === 'skipped')
    const errors = results.filter(r => r.status === 'error')
    const alreadyNew = results.filter(r => r.status === 'already-new')

    figma.notify(
      (dryRun ? '[PREVIEW] ' : '') +
      swapped.length + ' swapped, ' +
      skipped.length + ' skipped, ' +
      errors.length + ' errors, ' +
      alreadyNew.length + ' already new'
    )

    figma.ui.postMessage({
      type: 'results',
      dryRun,
      swapped: swapped.length,
      skipped: skipped.length,
      errors: errors.length,
      alreadyNew: alreadyNew.length,
      details: results,
    })
  }

  if (msg.type === 'navigate') {
    const node = await figma.getNodeByIdAsync(msg.nodeId as string) as SceneNode | null
    if (node) {
      figma.viewport.scrollAndZoomIntoView([node])
      figma.currentPage.selection = [node]
    }
  }
}
