// Where the API lives. Kept in its own module so components that need it can be tested without the Vite-only `import.meta`.
export const apiBase: string = import.meta.env?.VITE_API_BASE_URL || "";
