import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const MV_DESCRIPTION = `Moves or renames a file or directory.

Usage:
- ALWAYS prefer this tool over Write+delete when renaming or relocating files. Moving preserves git history, file metadata, and is significantly cheaper than rewriting content.
- When refactoring (e.g., renaming a module), move existing files first, then edit them. Do NOT recreate them.
- The "source" and "destination" parameters should be absolute paths. Relative paths are resolved against the project directory.
- Cross-volume moves are handled automatically (falls back to copy + delete when "rename" cannot cross the volume boundary).
- The destination's parent directory must already exist; this tool will not create missing parent directories.
- If the destination already exists, the move FAILS unless "overwrite" is true.
- Works identically on Windows, macOS, and Linux.
`;

const CP_DESCRIPTION = `Copies a file or directory.

Usage:
- ALWAYS prefer this tool over Write when duplicating an existing file as a starting point. Copying preserves content fidelity and is dramatically cheaper than re-emitting the file from the model. After copying, use Edit to make the variant-specific changes.
- The "source" and "destination" parameters should be absolute paths. Relative paths are resolved against the project directory.
- Directories are copied recursively automatically when the source is a directory.
- The destination's parent directory must already exist; this tool will not create missing parent directories.
- If the destination already exists and is a file, the copy FAILS unless "overwrite" is true.
- Symbolic links are preserved as links (not dereferenced).
- Works identically on Windows, macOS, and Linux.
`;

function resolveSessionPath(p: string, directory: string): string {
    return path.isAbsolute(p) ? p : path.resolve(directory, p);
}

function relativeToWorktree(absPath: string, worktree: string): string {
    const rel = path.relative(worktree, absPath);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return absPath;
    return rel;
}

function isInsideWorktree(absPath: string, worktree: string): boolean {
    const rel = path.relative(worktree, absPath);
    return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

type MoveOptions = {
    overwrite?: boolean;
};

type CopyOptions = {
    overwrite?: boolean;
};

/**
 * Cross-platform move/rename:
 * - Fast path: `fs.rename` (atomic on a single volume on every supported OS).
 * - Fallback: when `rename` fails with `EXDEV` (cross-device link), copy
 *   recursively then remove the source. This mirrors the semantics of the
 *   POSIX `mv(1)` and Windows `Move-Item` commands.
 */
async function moveFsEntry(source: string, destination: string, options: MoveOptions = {}): Promise<void> {
    const overwrite = options.overwrite ?? false;

    if (!overwrite) {
        const exists = await fs
            .stat(destination)
            .then(() => true)
            .catch((err: NodeJS.ErrnoException) => {
                if (err.code === "ENOENT") return false;
                throw err;
            });
        if (exists) {
            throw new Error(`Destination already exists: ${destination}. Pass overwrite=true to replace it.`);
        }
    } else {
        // Best-effort removal so `rename` succeeds on platforms that refuse
        // to overwrite an existing destination (notably Windows for files,
        // and any OS for non-empty directories).
        await fs.rm(destination, { recursive: true, force: true });
    }

    try {
        await fs.rename(source, destination);
        return;
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EXDEV") throw err;
    }

    // Cross-device fallback: copy then delete.
    await fs.cp(source, destination, {
        recursive: true,
        force: true,
        preserveTimestamps: true,
        verbatimSymlinks: true,
    });
    await fs.rm(source, { recursive: true, force: true });
}

async function copyFsEntry(source: string, destination: string, options: CopyOptions = {}): Promise<void> {
    const overwrite = options.overwrite ?? false;
    const stat = await fs.lstat(source);
    const recursive = stat.isDirectory();

    await fs.cp(source, destination, {
        recursive,
        force: overwrite,
        errorOnExist: !overwrite,
        preserveTimestamps: true,
        verbatimSymlinks: true,
    });
}

const plugin: Plugin = async (_input: PluginInput): Promise<Hooks> => {
    return {
        tool: {
            mv: tool({
                description: MV_DESCRIPTION,
                args: {
                    source: tool.schema.string().describe("Absolute path to the file or directory to move."),
                    destination: tool.schema.string().describe("Absolute path to move/rename to."),
                    overwrite: tool.schema
                        .boolean()
                        .optional()
                        .describe(
                            "Replace destination if it already exists. Defaults to false; set to true to clobber.",
                        ),
                },
                async execute(args, ctx) {
                    const source = resolveSessionPath(args.source, ctx.directory);
                    const destination = resolveSessionPath(args.destination, ctx.directory);

                    if (!isInsideWorktree(source, ctx.worktree) || !isInsideWorktree(destination, ctx.worktree)) {
                        await ctx.ask({
                            permission: "external_directory",
                            patterns: [source, destination],
                            always: [],
                            metadata: { tool: "mv", source, destination },
                        });
                    }

                    // Reuse the `edit` permission key used by the built-in
                    // write/edit/apply_patch tools so a user or agent that
                    // denies `edit` automatically denies mv/cp as well.
                    await ctx.ask({
                        permission: "edit",
                        patterns: [
                            relativeToWorktree(source, ctx.worktree),
                            relativeToWorktree(destination, ctx.worktree),
                        ],
                        always: ["*"],
                        metadata: {
                            tool: "mv",
                            source,
                            destination,
                            overwrite: args.overwrite ?? false,
                        },
                    });

                    await moveFsEntry(source, destination, { overwrite: args.overwrite ?? false });

                    const titleSrc = relativeToWorktree(source, ctx.worktree);
                    const titleDst = relativeToWorktree(destination, ctx.worktree);
                    return {
                        title: `${titleSrc} → ${titleDst}`,
                        output: `Moved ${titleSrc} → ${titleDst}`,
                        metadata: {
                            source,
                            destination,
                            overwrite: args.overwrite ?? false,
                        },
                    };
                },
            }),

            cp: tool({
                description: CP_DESCRIPTION,
                args: {
                    source: tool.schema.string().describe("Absolute path of the file or directory to copy."),
                    destination: tool.schema.string().describe("Absolute path to copy to."),
                    overwrite: tool.schema
                        .boolean()
                        .optional()
                        .describe(
                            "Overwrite the destination if it already exists. Defaults to false; set to true to clobber.",
                        ),
                },
                async execute(args, ctx) {
                    const source = resolveSessionPath(args.source, ctx.directory);
                    const destination = resolveSessionPath(args.destination, ctx.directory);

                    if (!isInsideWorktree(source, ctx.worktree) || !isInsideWorktree(destination, ctx.worktree)) {
                        await ctx.ask({
                            permission: "external_directory",
                            patterns: [source, destination],
                            always: [],
                            metadata: { tool: "cp", source, destination },
                        });
                    }

                    await ctx.ask({
                        permission: "edit",
                        patterns: [
                            relativeToWorktree(source, ctx.worktree),
                            relativeToWorktree(destination, ctx.worktree),
                        ],
                        always: ["*"],
                        metadata: {
                            tool: "cp",
                            source,
                            destination,
                            overwrite: args.overwrite ?? false,
                        },
                    });

                    await copyFsEntry(source, destination, { overwrite: args.overwrite ?? false });

                    const titleSrc = relativeToWorktree(source, ctx.worktree);
                    const titleDst = relativeToWorktree(destination, ctx.worktree);
                    return {
                        title: `${titleSrc} → ${titleDst}`,
                        output: `Copied ${titleSrc} → ${titleDst}`,
                        metadata: {
                            source,
                            destination,
                            overwrite: args.overwrite ?? false,
                        },
                    };
                },
            }),
        },
    };
};

export default plugin;
