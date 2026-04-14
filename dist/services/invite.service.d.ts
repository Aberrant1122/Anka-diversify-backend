export declare class InviteService {
    createInvite(data: {
        email: string;
        role: string;
        department?: string;
        invitedById: string;
    }): Promise<{
        invitedBy: {
            name: string | null;
            email: string;
        };
    } & {
        id: string;
        createdAt: Date;
        role: string;
        email: string;
        department: string | null;
        token: string;
        acceptedAt: Date | null;
        expiresAt: Date;
        invitedById: string;
    }>;
    getInvite(token: string): Promise<{
        invitedBy: {
            name: string | null;
            email: string;
        };
    } & {
        id: string;
        createdAt: Date;
        role: string;
        email: string;
        department: string | null;
        token: string;
        acceptedAt: Date | null;
        expiresAt: Date;
        invitedById: string;
    }>;
    acceptInvite(token: string, data: {
        name: string;
        password: string;
    }): Promise<{
        id: string;
        name: string | null;
        status: string;
        createdAt: Date;
        updatedAt: Date;
        role: string;
        email: string;
        password: string;
        department: string | null;
    }>;
    listInvites(invitedById: string): Promise<({
        invitedBy: {
            name: string | null;
        };
    } & {
        id: string;
        createdAt: Date;
        role: string;
        email: string;
        department: string | null;
        token: string;
        acceptedAt: Date | null;
        expiresAt: Date;
        invitedById: string;
    })[]>;
    revokeInvite(id: string): Promise<{
        id: string;
        createdAt: Date;
        role: string;
        email: string;
        department: string | null;
        token: string;
        acceptedAt: Date | null;
        expiresAt: Date;
        invitedById: string;
    }>;
    listUsers(): Promise<{
        id: string;
        name: string | null;
        status: string;
        createdAt: Date;
        role: string;
        email: string;
        department: string | null;
    }[]>;
    updateUser(id: string, data: {
        role?: string;
        department?: string;
        status?: string;
    }): Promise<{
        id: string;
        name: string | null;
        status: string;
        createdAt: Date;
        role: string;
        email: string;
        department: string | null;
    }>;
    removeUser(id: string): Promise<{
        id: string;
        name: string | null;
        status: string;
        createdAt: Date;
        updatedAt: Date;
        role: string;
        email: string;
        password: string;
        department: string | null;
    }>;
}
//# sourceMappingURL=invite.service.d.ts.map