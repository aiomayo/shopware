import { quoteJsString } from '../string-literals';
import type { CompositionScriptState } from './composition-script-state';
import { indentBlock, sanitizeTodoCommentText } from './helpers';
import { buildWatchSource, rewriteThisInBody } from './rewrite-this';

export function emitCreateExtendableSetup(lines: string[], state: CompositionScriptState): void {
    emitCreateExtendableSetupOpening(lines, state);
    emitCreateExtendableSetupOptions(lines, state);
    emitSupportedInjectProps(lines, state);
    emitSupportedDataProps(lines, state);
    emitSupportedComputedProps(lines, state);
    emitSupportedMethodProps(lines, state);
    emitUnsupportedWatchEntries(lines, state);
    emitSupportedWatchProps(lines, state);
    emitCreatedHooks(lines, state);
    emitRegularHooks(lines, state);
    emitCreateExtendableSetupReturn(lines, state);
    emitCreateExtendableSetupClosing(lines, state);
}

function emitCreateExtendableSetupOpening(lines: string[], state: CompositionScriptState): void {
    const { publicNames } = state;

    // createExtendableSetup is the Shopware compatibility layer for
    // overrideComponentSetup. Only names returned under `public` are available
    // to templates and downstream overrides.
    if (publicNames.length > 0) {
        lines.push('const {');
        publicNames.forEach((n) => lines.push(`    ${n},`));
        lines.push('} = createExtendableSetup(');
    } else {
        lines.push('createExtendableSetup(');
    }
}

function emitCreateExtendableSetupOptions(lines: string[], state: CompositionScriptState): void {
    const { registration } = state;

    lines.push('    {');
    lines.push(`        name: '${registration.componentName}',`);
    lines.push('        props,');
    lines.push('    },');
    lines.push('    () => {');
}

function emitSupportedInjectProps(lines: string[], state: CompositionScriptState): void {
    const { supportedInjectProps } = state;

    supportedInjectProps.forEach(({ localName, sourceKey, defaultValueText, treatDefaultAsFactory }) => {
        const args = [quoteJsString(sourceKey)];

        if (defaultValueText !== undefined) {
            args.push(defaultValueText);

            if (treatDefaultAsFactory) {
                args.push('true');
            }
        }

        lines.push(`        const ${localName} = inject(${args.join(', ')});`);
    });
    if (supportedInjectProps.length > 0) lines.push('');
}

function emitSupportedDataProps(lines: string[], state: CompositionScriptState): void {
    const { ctx, supportedDataProps } = state;

    supportedDataProps.forEach(({ name, valueText }) => {
        const rewrittenValue = rewriteThisInBody(valueText, ctx, 'expression');
        lines.push(`        const ${name} = ref(${rewrittenValue});`);
    });
    if (supportedDataProps.length > 0) lines.push('');
}

function emitSupportedComputedProps(lines: string[], state: CompositionScriptState): void {
    const { ctx, supportedComputedProps } = state;

    supportedComputedProps.forEach((prop) => {
        if (prop.kind === 'getter') {
            const body = rewriteThisInBody(prop.bodyText, ctx);
            lines.push(`        const ${prop.name} = computed(() => {`);
            lines.push(indentBlock(body, 12));
            lines.push(`        });`);
        } else {
            const getterBody = rewriteThisInBody(prop.getterBodyText, ctx);
            const setterBody = rewriteThisInBody(prop.setterBodyText, ctx);
            lines.push(`        const ${prop.name} = computed({`);
            lines.push(`            get: () => {`);
            lines.push(indentBlock(getterBody, 16));
            lines.push(`            },`);
            lines.push(`            set: (${prop.setterParam}) => {`);
            lines.push(indentBlock(setterBody, 16));
            lines.push(`            },`);
            lines.push(`        });`);
        }
    });
    if (supportedComputedProps.length > 0) lines.push('');
}

function emitSupportedMethodProps(lines: string[], state: CompositionScriptState): void {
    const { ctx, supportedMethodProps } = state;

    supportedMethodProps.forEach(({ name, paramsText, bodyText, isAsync, rawText }) => {
        if (rawText !== undefined) {
            // Property-assignment methods often wrap callbacks in helpers such
            // as debounce(). Preserve the wrapper expression instead of
            // flattening it into a plain arrow method.
            let rewritten = rewriteThisInBody(rawText, ctx, 'expression');
            rewritten = rewritten.replace(/\bfunction\s+\w*\s*\(([^)]*)\)\s*\{/g, '($1) => {');
            lines.push(`        const ${name} = ${rewritten};`);
        } else {
            const asyncKw = isAsync ? 'async ' : '';
            const body = rewriteThisInBody(bodyText, ctx);
            lines.push(`        const ${name} = ${asyncKw}(${paramsText}) => {`);
            lines.push(indentBlock(body, 12));
            lines.push(`        };`);
        }
    });
    if (supportedMethodProps.length > 0) lines.push('');
}

function emitUnsupportedWatchEntries(lines: string[], state: CompositionScriptState): void {
    const { unsupportedWatchEntries } = state;

    unsupportedWatchEntries.forEach((entry) => {
        lines.push(`        // TODO: migrate watch entry manually: ${sanitizeTodoCommentText(entry)}`);
    });
    if (unsupportedWatchEntries.length > 0) lines.push('');
}

function emitSupportedWatchProps(lines: string[], state: CompositionScriptState): void {
    const {
        ctx,
        injectNames,
        propNames,
        supportedWatchProps,
    } = state;

    supportedWatchProps.forEach(({ name, paramsText, bodyText, handlerName, isAsync, deep, immediate }) => {
        const source = buildWatchSource(name, propNames, injectNames);
        const hasOptions = deep || immediate;
        const optionsParts = [
            deep ? 'deep: true' : '',
            immediate ? 'immediate: true' : '',
        ].filter(Boolean);

        if (handlerName) {
            lines.push(
                `        watch(() => ${source}, (...args) => ${handlerName}(...args)${hasOptions ? `, { ${optionsParts.join(', ')} }` : ''});`,
            );
            return;
        }

        const body = rewriteThisInBody(bodyText ?? '', ctx);
        const asyncPrefix = isAsync ? 'async ' : '';
        const paramPart = paramsText ? `${asyncPrefix}(${paramsText}) => {` : `${asyncPrefix}() => {`;
        lines.push(`        watch(() => ${source}, ${paramPart}`);
        lines.push(indentBlock(body, 12));
        lines.push(hasOptions ? `        }, { ${optionsParts.join(', ')} });` : `        });`);
    });
    if (supportedWatchProps.length > 0) lines.push('');
}

function emitCreatedHooks(lines: string[], state: CompositionScriptState): void {
    const { ctx, lifecycleHooks } = state;
    const createdHooks = lifecycleHooks.filter((h) => h.compositionName === null);

    if (createdHooks.length === 0) {
        return;
    }

    // created() has no Composition API hook. Running it directly inside
    // setup preserves its pre-mount timing; async created() stays
    // fire-and-forget so setup itself does not become async.
    for (const hook of createdHooks) {
        const body = rewriteThisInBody(hook.bodyText, ctx);
        if (hook.isAsync) {
            lines.push('        void (async () => {');
            lines.push(indentBlock(body.trim(), 12));
            lines.push('        })();');
        } else {
            lines.push(indentBlock(body.trim(), 8));
        }
    }
    lines.push('');
}

function emitRegularHooks(lines: string[], state: CompositionScriptState): void {
    const { ctx, regularHooks } = state;

    for (const { compositionName, bodyText, isAsync } of regularHooks) {
        const body = rewriteThisInBody(bodyText, ctx);
        const asyncPrefix = isAsync ? 'async ' : '';
        lines.push(`        ${compositionName}(${asyncPrefix}() => {`);
        lines.push(indentBlock(body, 12));
        lines.push(`        });`);
    }
    if (regularHooks.length > 0) lines.push('');
}

function emitCreateExtendableSetupReturn(lines: string[], state: CompositionScriptState): void {
    const { publicNames } = state;

    lines.push('        return {');
    lines.push('            public: {');
    publicNames.forEach((n) => lines.push(`                ${n},`));
    lines.push('            },');
    lines.push('        };');
}

function emitCreateExtendableSetupClosing(lines: string[], state: CompositionScriptState): void {
    lines.push('    },');
    lines.push(');');
}
