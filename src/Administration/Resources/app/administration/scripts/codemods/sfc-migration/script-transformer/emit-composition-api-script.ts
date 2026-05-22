import type { CompositionScriptState } from './composition-script-state';
import { emitCreateExtendableSetup } from './emit-create-extendable-setup';

export function emitCompositionApiScript(state: CompositionScriptState): string {
    const lines: string[] = [];

    emitTodoComments(lines, state);
    emitModuleLevelCode(lines, state);
    emitCompilerMacros(lines, state);
    emitImports(lines, state);
    emitComposableDeclarations(lines, state);
    emitTemplateRefs(lines, state);
    emitCreateExtendableSetup(lines, state);

    return lines.join('\n');
}

function emitTodoComments(lines: string[], state: CompositionScriptState): void {
    const { todoComments } = state;

    if (todoComments.length > 0) {
        lines.push(todoComments.join('\n'));
        lines.push('');
    }
}

function emitModuleLevelCode(lines: string[], state: CompositionScriptState): void {
    const { moduleLevelCode } = state;

    if (moduleLevelCode) {
        lines.push(moduleLevelCode);
        lines.push('');
    }
}

function emitCompilerMacros(lines: string[], state: CompositionScriptState): void {
    const { componentNameValue, effectiveEmitsKeys, emitsDefinition, inheritAttrs, propsText, usedComposables } = state;
    const defineOptionsArgs = [
        !inheritAttrs ? 'inheritAttrs: false' : '',
        componentNameValue ? `name: ${componentNameValue}` : '',
    ].filter(Boolean);
    if (defineOptionsArgs.length > 0) {
        lines.push(`defineOptions({ ${defineOptionsArgs.join(', ')} });`);
        lines.push('');
    }

    if (propsText) {
        // TODO: Silent ignore: props definitions that reference module-local
        // declarations are emitted into defineProps even though script setup
        // compiler macros are hoisted and cannot depend on setup locals.
        lines.push(`const props = defineProps(${propsText});`);
    } else {
        lines.push(`const props = defineProps({});`);
    }

    if (emitsDefinition.objectText !== null) {
        // TODO: Silent ignore: emits validators that reference module-local
        // declarations are emitted into defineEmits even though script setup
        // compiler macros are hoisted and cannot depend on setup locals.
        lines.push(`const emit = defineEmits(${emitsDefinition.objectText});`);
    } else if (effectiveEmitsKeys.length > 0) {
        const emitsList = effectiveEmitsKeys.map((k) => `'${k}'`).join(', ');
        lines.push(`const emit = defineEmits([${emitsList}]);`);
    } else if (usedComposables.needsEmit) {
        lines.push(`const emit = defineEmits([]);`);
    }
    lines.push('');
}

function emitImports(lines: string[], state: CompositionScriptState): void {
    const { usedComposables, vueImports } = state;

    lines.push(`import { createExtendableSetup } from 'src/app/adapter/composition-extension-system';`);
    if (vueImports.length > 0) {
        lines.push(`import { ${[...new Set(vueImports)].join(', ')} } from 'vue';`);
    }

    const routerImports: string[] = [];
    if (usedComposables.needsRouter) routerImports.push('useRouter');
    if (usedComposables.needsRoute) routerImports.push('useRoute');
    if (routerImports.length > 0) {
        lines.push(`import { ${routerImports.join(', ')} } from 'vue-router';`);
    }
    if (usedComposables.needsI18n) {
        lines.push(`import { useI18n } from 'vue-i18n';`);
    }
    lines.push('');
}

function emitComposableDeclarations(lines: string[], state: CompositionScriptState): void {
    const { usedComposables } = state;

    if (usedComposables.needsRouter) lines.push(`const router = useRouter();`);
    if (usedComposables.needsRoute) lines.push(`const route = useRoute();`);
    if (usedComposables.needsSlots) lines.push(`const slots = useSlots();`);
    if (usedComposables.needsAttrs) lines.push(`const attrs = useAttrs();`);
    if (usedComposables.needsI18n) lines.push(`const { t } = useI18n();`);
    const hasComposableDeclarations =
        usedComposables.needsRouter ||
        usedComposables.needsRoute ||
        usedComposables.needsSlots ||
        usedComposables.needsAttrs ||
        usedComposables.needsI18n;
    if (hasComposableDeclarations) {
        lines.push('');
    }
}

function emitTemplateRefs(lines: string[], state: CompositionScriptState): void {
    const { templateRefNames } = state;

    for (const refName of templateRefNames) {
        lines.push(`const ${refName} = ref(null);`);
    }
    if (templateRefNames.length > 0) lines.push('');
}
