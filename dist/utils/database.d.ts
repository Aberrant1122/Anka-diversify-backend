export declare class DatabaseService {
    private db;
    constructor();
    private initialize;
    query(sql: string, params?: any[]): Promise<any[]>;
    get(sql: string, params?: any[]): Promise<any>;
    run(sql: string, params?: any[]): Promise<any>;
    close(): void;
}
//# sourceMappingURL=database.d.ts.map