const trustedAstNodes = new WeakSet<object>();

export function markTrustedAstNode<T extends object>(node: T): T {
    trustedAstNodes.add(node);
    return node;
}

export function isTrustedAstNode(value: unknown): boolean {
    return typeof value === "object" && value !== null && trustedAstNodes.has(value);
}
