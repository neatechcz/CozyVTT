import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AssetScope, AssetType, type Asset } from '@/types';
import AssetCard from './AssetCard';

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'owner', platformRole: 'USER' } }),
}));

const asset = {
  id: 'asset', name: 'Forest map', type: AssetType.MAP, scope: AssetScope.USER,
  uploadedById: 'owner', createdAt: '2026-09-01', fileSize: 1024, tags: [],
} as unknown as Asset;

describe('AssetCard touch access', () => {
  it('keeps grid actions mounted so touch and keyboard users can reach them without hover', () => {
    render(<AssetCard asset={asset} viewMode="grid" onView={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'View details' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });
});
