/**
 * 我的学生 /students —— 一个数据源，四个 saved view（UIUX §7.5）。
 *
 * 视图存在 URL 上（?view=… &q=… &sort=… &page=… &student=…），所以刷新不丢、可以直接
 * 把链接发给同事；换视图不是换页面，App 里只有一条路由。
 *
 * 四个视图的查询口径（按运行时实现，不是按 openapi 草案）：
 *   mine        owner_admin_id = 当前登录者
 *   low-credit  low_credit=1（服务端按 cfg.Thresholds.LowCreditThreshold 过滤）
 *   scheduling  active_class_count = 0。服务端没有「未排班」这个筛选参数，但**行上直接带**
 *               active_class_count（service/student.go:109-110），所以只需取一页再取补集，
 *               不必再去反查每个班的名册。代价是要一次多取一些（100 = 服务端 limit 上限），
 *               翻页也在本地做，界面上如实标注「filtered in the browser」。
 *   all         不加 student 级筛选
 *
 * 排序同理只发给服务端真正支持的 'name' / 'balance_asc'（service/student.go:94-99）。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { RotateCw, Search, X } from 'lucide-react';
import { Button, chipStateClass, Input } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { StudentPage } from '../lib/types';
import { StudentDrawer } from './StudentsPage.Drawer';
import { StudentsTable } from './StudentsPage.Table';
import type { SortKey } from './StudentsPage.Table';
import { useAsync } from './TodayPage.Async';

type ViewKey = 'mine' | 'low-credit' | 'scheduling' | 'all';

const VIEWS: { key: ViewKey; label: string; hint: string }[] = [
  { key: 'mine', label: '我的', hint: '顾问是你的全部学生。' },
  { key: 'low-credit', label: '课时不足', hint: '余额已达到续费阈值。' },
  { key: 'scheduling', label: '待排班', hint: '尚未报名任何在读班级。' },
  { key: 'all', label: '全部', hint: '全中心，包含其他顾问的学生。' },
];

const LIMIT = 20;
/** 服务端 limit 上限 200，100 足够覆盖一个中心的在册学生；「待排班」靠它一次取完再做本地补集。 */
const SCHEDULING_FETCH = 100;

interface ListResult {
  page: StudentPage;
  clientFiltered: boolean;
}

function isViewKey(value: string | null): value is ViewKey {
  return value === 'mine' || value === 'low-credit' || value === 'scheduling' || value === 'all';
}

export default function StudentsPage() {
  const { me } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const myId = me?.user.id;

  const rawView = params.get('view');
  const view: ViewKey = isViewKey(rawView) ? rawView : 'mine';
  const query = params.get('q') ?? '';
  const rawSort = params.get('sort');
  const sort: SortKey = rawSort === 'name' || rawSort === 'balance_asc' ? rawSort : '';
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);
  const openId = Number(params.get('student') ?? '') || null;

  const [term, setTerm] = useState(query);
  useEffect(() => setTerm(query), [query]);

  function update(changes: Record<string, string | null>, replace = false) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [key, value] of Object.entries(changes)) {
          if (value === null || value === '') next.delete(key);
          else next.set(key, value);
        }
        return next;
      },
      { replace },
    );
  }

  // 输入停顿 300ms 再改 URL，避免每敲一个字就打一次接口、塞一条历史记录。
  useEffect(() => {
    if (term === query) return;
    const timer = window.setTimeout(() => update({ q: term || null, page: null }, true), 300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term, query]);

  const list = useAsync<ListResult>(async () => {
    // 「待排班」是在本地翻页的（要把整窗取回来再取补集），所以永远只取第 1 窗：
    // 把 page 也发给服务端，会变成服务端先 OFFSET 一次、本地再用同一个 page 切一次 ——
    // 第 2 页切到空数组上，表格会显示「Every student already has a class」这句假话。
    const res = await api.get<StudentPage>('/students', {
      q: query || undefined,
      sort: sort || undefined,
      // 'me' 是服务端为此提供的值。用本地 user id 也能跑，但那样「我是谁」就成了
      // 前端的一处前置条件：id 缺失时这个过滤会**静默消失**，页面照常返回全中心的学生。
      // 交给服务端，它会用凭据回答；真的认不出来时给 401 而不是给全表。
      owner_admin_id: view === 'mine' ? 'me' : undefined,
      low_credit: view === 'low-credit' ? 1 : undefined,
      limit: view === 'scheduling' ? SCHEDULING_FETCH : LIMIT,
      page: view === 'scheduling' ? 1 : page,
    });

    if (view !== 'scheduling') return { page: res, clientFiltered: false };

    // 服务端已经按 sort 排好序，过滤只做筛选，不重排，免得两边顺序不一致。
    //
    // status === 'active' 是「待排班」的定义的一部分：这个视图的 hint 写的是
    // 「尚未报名**在读**班级」，而 lead 根本不在读 —— 他缺的不是一个班，是一次成交。
    // 去掉线索/试听学生的班级之后，他们全员 active_class_count === 0，不加这个谓词
    // 就会整批涌进这个视图。
    const unscheduled = res.items.filter(
      (student) => student.status === 'active' && student.active_class_count === 0,
    );
    const start = (page - 1) * LIMIT;
    return {
      page: {
        ...res,
        items: unscheduled.slice(start, start + LIMIT),
        total: unscheduled.length,
        has_more: start + LIMIT < unscheduled.length,
      },
      clientFiltered: true,
    };
  }, [view, page, query, sort]);

  const activeView = VIEWS.find((v) => v.key === view) ?? VIEWS[0];
  const students = list.data?.page.items ?? [];
  const total = list.data?.page.total ?? 0;
  const hasMore = list.data?.page.has_more ?? false;

  const empty = useMemo(() => {
    if (query) {
      return { message: `此视图中没有匹配“${query}”的学生。`, cta: '清除搜索', go: () => update({ q: null, page: null }) };
    }
    switch (view) {
      case 'mine':
        return { message: '还没有分配给你的学生。', cta: '查看全部学生', go: () => update({ view: 'all', page: null }) };
      case 'low-credit':
        return { message: '没有学生达到续费阈值。', cta: '查看全部学生', go: () => update({ view: 'all', page: null }) };
      case 'scheduling':
        return { message: '所有学生都已报名班级。', cta: '打开班级', go: () => navigate('/classes') };
      default:
        return { message: '还没有任何学生记录。请先登记第一条线索。', cta: '打开线索', go: () => navigate('/leads') };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, view]);

  return (
    <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-4 px-5 py-5">
      <header className="flex flex-col gap-1">
        <h1 className="page-title text-fg">学生</h1>
        <p className="text-meta text-muted">{activeView.hint}</p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1" role="group" aria-label="已存视图">
          {VIEWS.map((item) => (
            <button
              key={item.key}
              type="button"
              aria-pressed={view === item.key}
              onClick={() => update({ view: item.key, page: null })}
              className={`h-7 rounded-sm px-2.5 text-meta font-510 transition-colors duration-150 ease-standard ${chipStateClass(
                view === item.key,
              )}`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <span className="relative">
          <Search size={16} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
          <Input
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="按姓名搜索"
            aria-label="按姓名搜索学生"
            className="w-[240px] pl-7 pr-7"
          />
          {term && (
            <button
              type="button"
              aria-label="清除搜索"
              onClick={() => setTerm('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded-sm text-muted hover:text-fg transition-colors duration-150 ease-standard"
            >
              <X size={16} aria-hidden />
            </button>
          )}
        </span>

        <span className="ml-auto flex items-center gap-2">
          <span className="num text-meta text-muted">共 {total} 名学生</span>
          <Button variant="ghost" size="sm" onClick={list.reload}>
            <RotateCw size={16} aria-hidden />
            刷新
          </Button>
        </span>
      </div>

      <StudentsTable
        students={students}
        loading={list.loading && list.data === null}
        error={list.error}
        onRetry={list.reload}
        sort={sort}
        onSort={(next) => update({ sort: next || null, page: null })}
        myId={myId}
        onOpen={(id) => update({ student: String(id) }, true)}
        emptyMessage={empty.message}
        emptyCta={empty.cta}
        onEmptyCta={empty.go}
      />

      {!list.error && total > 0 && (
        <div className="flex items-center justify-between gap-3">
          <span className="num text-meta text-muted">
            第 {page} 页 · 显示 {students.length} / {total} 条
            {list.data?.clientFiltered ? ' · 浏览器内筛选' : ''}
          </span>
          <span className="flex items-center gap-2">
            <Button size="sm" disabled={page <= 1} onClick={() => update({ page: String(page - 1) })}>
              上一页
            </Button>
            <Button size="sm" disabled={!hasMore} onClick={() => update({ page: String(page + 1) })}>
              下一页
            </Button>
          </span>
        </div>
      )}

      {openId !== null && <StudentDrawer studentId={openId} myId={myId} onClose={() => update({ student: null }, true)} />}
    </div>
  );
}
