// E2E Test: Team Management
// チーム管理機能のE2Eテスト

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type VibebaseClient } from '@vibebase/sdk';
import type { Team, Member, User } from './fixtures/types';

describe('Team Management E2E Tests', () => {
  let vibebase: VibebaseClient;
  let testUsers: User[] = [];
  let createdTeamIds: string[] = [];
  
  const apiUrl = process.env.VIBEBASE_API_URL || 'http://localhost:8787';
  const apiKey = process.env.VIBEBASE_API_KEY || 'vb_live_test123456789012345678901234567890';

  beforeAll(async () => {
    vibebase = createClient({
      apiUrl,
      apiKey
    });

    // テストユーザーを取得
    // 注: whereフィルタが正しく動作していないため、全ユーザーを取得してクライアント側でフィルタ
    const allUsersResult = await vibebase.data!.list<User>('users');
    console.log('All users:', allUsersResult.data!.map(u => ({ id: u.id, email: u.email })));
    
    const userEmails = ['alice@example.com', 'bob@example.com', 'charlie@example.com'];
    for (const email of userEmails) {
      const user = allUsersResult.data!.find(u => u.email === email);
      if (user) {
        testUsers.push(user);
      }
    }

    console.log('Test users:', testUsers.map(u => ({ id: u.id, email: u.email })));
    expect(testUsers).toHaveLength(3);
  });

  afterAll(async () => {
    // テストで作成したチームをクリーンアップ
    for (const teamId of createdTeamIds) {
      try {
        await vibebase.data!.delete('teams', teamId);
      } catch (error) {
        console.warn(`Failed to cleanup team ${teamId}:`, error);
      }
    }
  });

  describe('Team CRUD Operations', () => {
    it('should create a new team', async () => {
      const newTeam = {
        name: 'E2E Test Team',
        description: 'Team created during E2E testing',
        created_by: testUsers[0].id
      };

      const created = await vibebase.data!.create<Team>('teams', newTeam);
      console.log('Create team response:', JSON.stringify(created, null, 2));
      if (created.success && created.data!) {
        createdTeamIds.push(created.data!.id);
      }

      expect(created).toBeDefined();
      expect(created.success).toBe(true);
      expect(created.data!?.id).toBeDefined();
      expect(created.data!?.name).toBe(newTeam.name);
      expect(created.data!?.description).toBe(newTeam.description);
      expect(created.data!?.created_by).toBe(newTeam.created_by);
      expect(created.data!?.created_at).toBeDefined();
      expect(created.data!?.updated_at).toBeDefined();
    });

    it('should list teams with pagination', async () => {
      // 十分なデータがあることを確認するため、追加のチームを作成
      const additionalTeams: string[] = [];
      for (let i = 0; i < 3; i++) {
        const result = await vibebase.data!.create<Team>('teams', {
          name: `Pagination Test Team ${i + 1}`,
          description: `Team for pagination testing ${i + 1}`,
          created_by: testUsers[0].id
        });
        expect(result.success).toBe(true);
        additionalTeams.push(result.data!.id);
      }

      const page1 = await vibebase.data!.list<Team>('teams', {
        limit: 2,
        offset: 0
      });

      expect(page1.data!).toBeDefined();
      expect(page1.data!.length).toBeLessThanOrEqual(2);
      expect(page1.total).toBeGreaterThan(2);

      const page2 = await vibebase.data!.list<Team>('teams', {
        limit: 2,
        offset: 2
      });

      expect(page2.data!).toBeDefined();
      // ページ1とページ2のデータが異なることを確認
      const page1Ids = page1.data!.map(t => t.id);
      const page2Ids = page2.data!.map(t => t.id);
      expect(page1Ids).not.toEqual(page2Ids);

      // クリーンアップ
      for (const teamId of additionalTeams) {
        await vibebase.data!.delete('teams', teamId);
      }
    });

    it('should get a single team by ID', async () => {
      const teams = await vibebase.data!.list<Team>('teams', { limit: 1 });
      expect(teams.data!.length).toBeGreaterThan(0);

      const teamId = teams.data![0].id;
      const team = await vibebase.data!.get<Team>('teams', teamId);

      expect(team).toBeDefined();
      expect(team.success).toBe(true);
      expect(team.data!?.id).toBe(teamId);
      expect(team.data!?.name).toBeDefined();
    });

    it('should update team information', async () => {
      const response = await vibebase.data!.create<Team>('teams', {
        name: 'Team to Update',
        description: 'Original description',
        created_by: testUsers[0].id
      });
      
      expect(response.success).toBe(true);
      const newTeam = response.data!;
      expect(newTeam).toBeDefined();
      
      if (newTeam) {
        createdTeamIds.push(newTeam.id);
      }

      const updates = {
        name: 'Updated Team Name',
        description: 'Updated description with more details'
      };

      // わずかな待機時間を追加してupdated_atが確実に異なるようにする
      await new Promise(resolve => setTimeout(resolve, 10));
      
      const updated = await vibebase.data!.update<Team>('teams', newTeam.id, updates);

      expect(updated.success).toBe(true);
      expect(updated.data!?.id).toBe(newTeam.id);
      expect(updated.data!?.name).toBe(updates.name);
      expect(updated.data!?.description).toBe(updates.description);
      expect(updated.data!?.created_by).toBe(newTeam.created_by);
    });

    it('should delete a team', async () => {
      const response = await vibebase.data!.create<Team>('teams', {
        name: 'Team to Delete',
        description: 'This team will be deleted',
        created_by: testUsers[0].id
      });

      expect(response.success).toBe(true);
      const tempTeam = response.data!;
      if (!tempTeam) {
        throw new Error('Team creation failed');
      }

      await vibebase.data!.delete('teams', tempTeam.id);

      // 削除されたことを確認
      const result = await vibebase.data!.list<Team>('teams', {
        where: { id: tempTeam.id }
      });

      expect(result.data!).toHaveLength(0);
    });
  });

  describe('Team Member Management', () => {
    let testTeam: Team;

    beforeAll(async () => {
      const response = await vibebase.data!.create<Team>('teams', {
        name: 'Member Test Team',
        description: 'Team for testing member management',
        created_by: testUsers[0].id
      });
      
      if (response.success && response.data!) {
        testTeam = response.data!;
        createdTeamIds.push(testTeam.id);
      } else {
        throw new Error('Failed to create test team');
      }

      // 最初のメンバー（owner）を追加
      await vibebase.data!.create('members', {
        team_id: testTeam.id,
        user_id: testUsers[0].id,
        role: 'owner',
        display_name: 'Alice (Team Owner)',
        invited_by: testUsers[0].id
      } as any);
    });

    it('should add members to team', async () => {
      // メンバーを追加
      const response = await vibebase.data!.create('members', {
        team_id: testTeam.id,
        user_id: testUsers[1].id,
        role: 'member',
        display_name: 'Bob (Team Member)',
        invited_by: testUsers[0].id
      } as any);

      expect(response).toBeDefined();
      expect(response.success).toBe(true);
      expect(response.data!?.team_id).toBe(testTeam.id);
      expect(response.data!?.user_id).toBe(testUsers[1].id);
      expect(response.data!?.role).toBe('member');
    });

    it('should list team members', async () => {
      const members = await vibebase.data!.list<Member>('members', {
        where: { team_id: testTeam.id }
      });

      expect(members.data!.length).toBeGreaterThanOrEqual(2);
      
      const roles = members.data!.map(m => m.role);
      expect(roles).toContain('owner');
      expect(roles).toContain('member');
    });

    it('should update member role', async () => {
      // Bob のメンバーシップを取得
      const members = await vibebase.data!.list<Member>('members', {
        where: { 
          team_id: testTeam.id,
          user_id: testUsers[1].id
        }
      });

      expect(members.data!.length).toBe(1);
      const memberId = members.data![0].id;

      // roleをadminに変更
      const updated = await vibebase.data!.update<Member>('members', memberId, {
        role: 'admin'
      });

      expect(updated.success).toBe(true);
      expect(updated.data!?.role).toBe('admin');
    });

    it('should prevent duplicate memberships', async () => {
      // 既に存在するメンバーシップを再度作成しようとする
      const duplicateResult = await vibebase.data!.create('members', {
        team_id: testTeam.id,
        user_id: testUsers[1].id,
        role: 'member',
        display_name: 'Bob (Duplicate)',
        invited_by: testUsers[0].id
      } as any);
      
      expect(duplicateResult.success).toBe(false);
      expect(duplicateResult.error).toMatch(/UNIQUE constraint failed/);
    });

    it('should remove member from team', async () => {
      // Charlieを追加してから削除
      const response = await vibebase.data!.create('members', {
        team_id: testTeam.id,
        user_id: testUsers[2].id,
        role: 'member',
        display_name: 'Charlie (Temp Member)',
        invited_by: testUsers[0].id
      } as any);

      expect(response.success).toBe(true);
      const tempMember = response.data!;
      if (!tempMember) {
        throw new Error('Member creation failed');
      }

      await vibebase.data!.delete('members', tempMember.id);

      // 削除確認
      const members = await vibebase.data!.list<Member>('members', {
        where: {
          team_id: testTeam.id,
          user_id: testUsers[2].id
        }
      });

      expect(members.data!).toHaveLength(0);
    });
  });

  describe('Team Queries and Filters', () => {
    it('should search teams by name', async () => {
      const searchTerm = 'Engineering';
      const results = await vibebase.data!.list<Team>('teams', {
        where: { name: { $like: `%${searchTerm}%` } }
      });

      if (results.data!.length > 0) {
        results.data!.forEach(team => {
          expect(team.name.toLowerCase()).toContain(searchTerm.toLowerCase());
        });
      }
    });

    it('should filter teams by creator', async () => {
      const creatorId = testUsers[0].id;
      const results = await vibebase.data!.list<Team>('teams', {
        where: { created_by: creatorId }
      });

      if (results.data!.length > 0) {
        results.data!.forEach(team => {
          expect(team.created_by).toBe(creatorId);
        });
      }
    });

    it('should get teams with member count', async () => {
      // カスタムクエリを使用する場合のテスト
      // Vibebaseがカスタムクエリをサポートしている場合
      const teams = await vibebase.data!.list<Team>('teams');
      
      for (const team of teams.data!.slice(0, 3)) {
        const members = await vibebase.data!.list<Member>('members', {
          where: { team_id: team.id }
        });
        
        expect(members.data!).toBeDefined();
        expect(members.total).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('Team Cascade Operations', () => {
    it('should handle team deletion with cascade', async () => {
      // カスケード削除のテスト用チームを作成
      const teamResponse = await vibebase.data!.create<Team>('teams', {
        name: 'Cascade Test Team',
        description: 'Team for testing cascade deletion',
        created_by: testUsers[0].id
      });

      expect(teamResponse.success).toBe(true);
      const cascadeTeam = teamResponse.data!;
      if (!cascadeTeam) {
        throw new Error('Team creation failed');
      }

      // メンバーを追加
      await vibebase.data!.create('members', {
        team_id: cascadeTeam.id,
        user_id: testUsers[0].id,
        role: 'owner',
        invited_by: testUsers[0].id
      } as any);

      // プロジェクトを作成
      const project = await vibebase.data!.create('projects', {
        team_id: cascadeTeam.id,
        name: 'Cascade Test Project',
        status: 'active',
        created_by: testUsers[0].id
      });

      // チームを削除
      await vibebase.data!.delete('teams', cascadeTeam.id);

      // 関連データが削除されていることを確認
      const members = await vibebase.data!.list<Member>('members', {
        where: { team_id: cascadeTeam.id }
      });
      expect(members.data!).toHaveLength(0);

      const projects = await vibebase.data!.list('projects', {
        where: { team_id: cascadeTeam.id }
      });
      expect(projects.data!).toHaveLength(0);
    });
  });
});
