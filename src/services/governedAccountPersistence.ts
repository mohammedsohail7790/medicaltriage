import type { DirectoryStatus } from "@prisma/client";
import { shouldPersistSessionsInDatabase } from "../config/runtime.js";
import { prisma } from "../db.js";
import type { AdminUser } from "../types/security.js";
import {
  decryptGovernedIdentifier,
  encryptGovernedIdentifier,
  governedEmailBlindIndex,
  hashGovernedPassword
} from "./governedAccountCrypto.js";

export type PersistedGovernedAccount = { user: AdminUser; passwordHash: string };

function enabled(): boolean {
  return shouldPersistSessionsInDatabase();
}

function directoryStatus(value: AdminUser["directoryStatus"]): DirectoryStatus {
  return (value ?? "active").toUpperCase() as DirectoryStatus;
}

async function accountFromRow(row: Awaited<ReturnType<typeof prisma.applicationUser.findUnique>>): Promise<PersistedGovernedAccount | undefined> {
  if (!row?.passwordHash || !row.emailCiphertext) return undefined;
  const assignments = await prisma.userRole.findMany({ where: { userId: row.id, status: "active" } });
  return {
    passwordHash: row.passwordHash,
    user: {
      id: row.id,
      employeeId: row.employeeId ?? "",
      hrmsId: row.hrmsId ?? "",
      fullName: row.fullName,
      email: decryptGovernedIdentifier(row.emailCiphertext),
      mobile: row.mobileCiphertext ? decryptGovernedIdentifier(row.mobileCiphertext) : "",
      organization: row.organization,
      organizationId: row.organizationId ?? undefined,
      facility: row.facility ?? "",
      department: row.department ?? "",
      clinicalSpecialty: row.clinicalSpecialty ?? "Not applicable",
      jobTitle: row.jobTitle ?? "",
      professionalCategory: row.professionalCategory ?? "Administrator",
      manager: row.managerUserId ?? "",
      country: row.country,
      preferredLanguage: row.preferredLanguage as AdminUser["preferredLanguage"],
      timeZone: row.timeZone,
      authenticationMethod: row.authenticationMethod as AdminUser["authenticationMethod"],
      mfaStatus: row.mfaStatus as AdminUser["mfaStatus"],
      accountStatus: row.accountStatus as AdminUser["accountStatus"],
      directoryStatus: row.directoryStatus.toLowerCase() as AdminUser["directoryStatus"],
      roles: assignments.map((assignment) => assignment.roleCode),
      responsibilities: [],
      queues: [],
      accessProfiles: [],
      createdBy: row.createdBy ?? "unknown",
      createdAtIso: row.createdAt.toISOString(),
      updatedBy: row.updatedBy ?? "unknown",
      updatedAtIso: row.updatedAt.toISOString()
    }
  };
}

export async function persistGovernedAccount(user: AdminUser, temporaryPassword: string, mustChangePassword = false): Promise<void> {
  if (!enabled()) return;
  const passwordHash = hashGovernedPassword(temporaryPassword);
  await prisma.$transaction(async (tx) => {
    await tx.applicationUser.upsert({
      where: { id: user.id },
      create: {
        id: user.id,
        employeeId: user.employeeId,
        hrmsId: user.hrmsId || null,
        fullName: user.fullName,
        emailCiphertext: encryptGovernedIdentifier(user.email),
        emailBlindIndex: governedEmailBlindIndex(user.email),
        mobileCiphertext: user.mobile ? encryptGovernedIdentifier(user.mobile) : null,
        organization: user.organization,
        organizationId: user.organizationId ?? null,
        facility: user.facility,
        department: user.department,
        clinicalSpecialty: user.clinicalSpecialty,
        jobTitle: user.jobTitle,
        professionalCategory: user.professionalCategory,
        country: user.country,
        preferredLanguage: user.preferredLanguage,
        timeZone: user.timeZone,
        authenticationMethod: user.authenticationMethod,
        mfaStatus: user.mfaStatus,
        accountStatus: user.accountStatus,
        directoryStatus: directoryStatus(user.directoryStatus),
        passwordHash,
        mustChangePassword,
        createdBy: user.createdBy,
        updatedBy: user.updatedBy
      },
      update: { passwordHash, mustChangePassword, passwordChangedAt: null, accountStatus: user.accountStatus, updatedBy: user.updatedBy }
    });
    await tx.userRole.deleteMany({ where: { userId: user.id } });
    await tx.userRole.createMany({ data: user.roles.map((roleCode) => ({ userId: user.id, roleCode, approvedBy: user.createdBy })) });
  });
}

export async function findGovernedAccount(login: string): Promise<PersistedGovernedAccount | undefined> {
  if (!enabled() || !login.includes("@")) return undefined;
  const row = await prisma.applicationUser.findUnique({ where: { emailBlindIndex: governedEmailBlindIndex(login) } });
  return accountFromRow(row);
}

export async function listGovernedAccounts(): Promise<PersistedGovernedAccount[]> {
  if (!enabled()) return [];
  const rows = await prisma.applicationUser.findMany({ where: { passwordHash: { not: null } } });
  return (await Promise.all(rows.map(accountFromRow))).filter((value): value is PersistedGovernedAccount => Boolean(value));
}

export async function persistGovernedAccountStatus(user: AdminUser): Promise<void> {
  if (!enabled()) return;
  await prisma.applicationUser.updateMany({
    where: { id: user.id, passwordHash: { not: null } },
    data: { accountStatus: user.accountStatus, updatedBy: user.updatedBy }
  });
}

// ---- NFR-016: password lifecycle -------------------------------------------------------------

export type GovernedPasswordState = { changedAt?: Date; createdAt: Date; mustChange: boolean; history: string[] };

export async function getGovernedPasswordState(userId: string, historyCount: number): Promise<GovernedPasswordState | undefined> {
  if (!enabled()) return undefined;
  const row = await prisma.applicationUser.findUnique({ where: { id: userId }, select: { passwordChangedAt: true, createdAt: true, mustChangePassword: true, passwordHash: true } });
  if (!row?.passwordHash) return undefined;
  const history = historyCount > 0 ? await prisma.passwordHistory.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: historyCount }) : [];
  return {
    changedAt: row.passwordChangedAt ?? undefined,
    createdAt: row.createdAt,
    mustChange: row.mustChangePassword,
    history: [row.passwordHash, ...history.map((entry) => entry.passwordHash)]
  };
}

/** Stores the new password, keeps the old hash in history, and clears the must-change flag. */
export async function persistGovernedPasswordChange(userId: string, newPassword: string, historyKeep: number): Promise<void> {
  if (!enabled()) return;
  const newHash = hashGovernedPassword(newPassword);
  await prisma.$transaction(async (tx) => {
    const row = await tx.applicationUser.findUnique({ where: { id: userId }, select: { passwordHash: true } });
    if (row?.passwordHash) await tx.passwordHistory.create({ data: { userId, passwordHash: row.passwordHash } });
    await tx.applicationUser.update({ where: { id: userId }, data: { passwordHash: newHash, passwordChangedAt: new Date(), mustChangePassword: false } });
    const stale = await tx.passwordHistory.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, skip: Math.max(historyKeep, 1), select: { id: true } });
    if (stale.length > 0) await tx.passwordHistory.deleteMany({ where: { id: { in: stale.map((entry) => entry.id) } } });
  });
}
