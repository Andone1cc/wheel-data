              style={{background:loading==='refresh'?V('line'):ACC.blueBg,color:loading==='refresh'?V('faint'):ACC.blue,
                border:`1.5px solid ${loading==='refresh'?V('line'):`${ACC.blue}44`}`,fontWeight:500}}>
              {loading==='refresh'?'拉取中…':'↻ CBOE 刷新'}
            </button>
            {tab==='active'&&<button onClick={()=>setShowForm(s=>!s)} className="btn"
              style={{background:ACC.amberSoft,color:ACC.amber,border:`1.5px solid ${ACC.amber}44`,fontWeight:600}}>
              {showForm?'✕ 取消':'＋ 添加'}
            </button>}
            <button className="theme-btn" onClick={toggleTheme} title={theme==='dark'?'切换浅色':'切换深色'}>{theme==='dark'?'☀':'🌙'}</button>
          </div>
        </div>
      </div>

      {/* ── 主体布局 ── */}
      <div className="layout" style={{flex:1}}>
        {/* 左侧 Tab 导航 */}
        <div className="sidebar">
          <div className="sidebar-section">仓位</div>
          <button className={`tab-btn${tab==='active'?' active':''}`} onClick={()=>setTab('active')}>
            <span className="tab-dot" style={{background:ACC.profit}}/>
            <span className="tab-label tab-label-full">活跃期权</span><span className="tab-label tab-label-short">活跃</span>
            <span className="tab-count">{positions.length}</span>
          </button>
          <button className={`tab-btn${tab==='stocks'?' active':''}`} onClick={()=>setTab('stocks')}>
            <span className="tab-dot" style={{background:ACC.blue}}/>
            <span className="tab-label tab-label-full">股票持仓</span><span className="tab-label tab-label-short">股票</span>
            <span className="tab-count">{stocks.length}</span>
          </button>
          <button className={`tab-btn${tab==='closed'?' active':''}`} onClick={()=>setTab('closed')}>
            <span className="tab-dot" style={{background:V('faint')}}/>
            <span className="tab-label tab-label-full">已平仓</span><span className="tab-label tab-label-short">平仓</span>
            <span className="tab-count">{closed.length}</span>
          </button>
          <div className="sidebar-sep"/>
          <div className="sidebar-section">底仓</div>
          <button className={`tab-btn${tab==='sgov'?' active':''}`} onClick={()=>setTab('sgov')}>
            <span className="tab-dot" style={{background:ACC.teal}}/>
            <span className="tab-label">SGOV</span>
          </button>
          <div className="sidebar-sep"/>
          <div className="sidebar-section">工具</div>
          <button className={`tab-btn${tab==='watchlist'?' active':''}`} onClick={()=>setTab('watchlist')}>
            <span className="tab-dot" style={{background:ACC.blue}}/>
            <span className="tab-label tab-label-full">观察列表</span><span className="tab-label tab-label-short">观察</span>
          </button>
          <button className={`tab-btn${tab==='scan'?' active':''}`} onClick={()=>setTab('scan')}>
            <span className="tab-dot" style={{background:ACC.amber}}/>
            <span className="tab-label tab-label-full">期权筛选</span><span className="tab-label tab-label-short">筛选</span>
          </button>
          <button className={`tab-btn${tab==='finews'?' active':''}`} onClick={()=>setTab('finews')}>
            <span className="tab-dot" style={{background:ACC.teal}}/>
            <span className="tab-label tab-label-full">收藏网站</span><span className="tab-label tab-label-short">收藏</span>
          </button>
          <button className={`tab-btn${tab==='learn'?' active':''}`} onClick={()=>setTab('learn')}>
            <span className="tab-dot" style={{background:ACC.purple}}/>
            <span className="tab-label tab-label-full">期权学习</span><span className="tab-label tab-label-short">学习</span>
          </button>
        </div>

        {/* 右侧内容 */}
        <div className="main-area">
          {/* 活跃仓位 Tab */}
          {tab==='active'&&(
            <>
              {showForm&&<AddForm onAdd={addPosition} onCancel={()=>setShowForm(false)} commPerSide={commPerSide}/>}
              {positions.length>0&&<SummaryBar positions={positions} commPerSide={commPerSide} sgov={sgov}/>}
              {positions.length===0&&!showForm&&(
                <div style={{textAlign:'center',padding:'70px 20px',color:V('faint'),border:`1.5px dashed ${V('line')}`,borderRadius:16}}>
                  <div style={{fontSize:38,marginBottom:12,opacity:.3}}>◎</div>
                  <div style={{fontSize:15,marginBottom:6,color:V('dim')}}>还没有活跃仓位</div>
                  <div style={{fontSize:13}}>点击右上角「＋ 添加」录入</div>
                </div>
              )}
              {positions.length>0&&(
                <div className="pos-list">
                  <ActiveTableHeader/>
                  {positions.map(p=>(
                    <PositionRow key={p.id} p={p} commPerSide={commPerSide}
                      expanded={expanded===p.id}
                      onToggle={()=>toggleExpand(p.id)}
                      onUpdateOptionPrice={updateOptionPrice}
                      onClose={()=>{setCloseTarget(p);setExpanded(null);}}
                      onDelete={()=>removePosition(p.id)}
                      onRoll={()=>{setRollTarget(p);setExpanded(null);}}/>
                  ))}
                </div>
              )}
            </>
          )}

          {/* 已平仓 Tab */}
          {tab==='closed'&&(
            <>
              <ClosedSummary closed={closed} commPerSide={commPerSide}/>
              {closed.length===0?(
                <div style={{textAlign:'center',padding:'70px 20px',color:V('faint'),border:`1.5px dashed ${V('line')}`,borderRadius:16}}>
                  <div style={{fontSize:38,marginBottom:12,opacity:.3}}>📋</div>
                  <div style={{fontSize:15,marginBottom:6,color:V('dim')}}>暂无平仓记录</div>
                  <div style={{fontSize:13}}>在「活跃期权」展开一笔，点击「↩ 平仓」</div>
                </div>
              ):(<>
                <ClosedTableHeader/>
                {closed.map(c=><ClosedRow key={c.id} c={c} commPerSide={commPerSide} onDelete={()=>removeClosedRecord(c.id)}/>)}
              </>)}
            </>
          )}

          {/* 股票持仓 Tab */}
          {tab==='stocks'&&(
            <>
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:14,flexWrap:'wrap',gap:8}}>
                <div>
                  <div style={{fontWeight:700,fontSize:15,marginBottom:2}}>股票持仓</div>
                  <div style={{fontSize:12,color:V('dim'),fontFamily:'IBM Plex Mono,monospace'}}>接货自动录入 · 可手动添加 · 刷新股价同步更新</div>
                </div>
                <button onClick={()=>setShowStockForm(s=>!s)} className="btn"
                  style={{background:ACC.profit+'18',color:ACC.profit,border:`1.5px solid ${ACC.profit}44`,fontWeight:600}}>
                  {showStockForm?'✕ 取消':'＋ 手动添加'}
                </button>
              </div>
              {showStockForm&&<AddStockForm
                onAdd={s=>{mutateStocks([...stocks,s]);setShowStockForm(false);showToast(`已添加 ${s.ticker} ${s.shares}股`);}}
                onCancel={()=>setShowStockForm(false)}/>}
              <StocksSummary stocks={stocks}/>
              {stocks.length===0&&!showStockForm?(
                <div style={{textAlign:'center',padding:'60px 20px',color:V('faint'),border:`1.5px dashed ${V('line')}`,borderRadius:16}}>
                  <div style={{fontSize:38,marginBottom:12,opacity:.3}}>📊</div>
                  <div style={{fontSize:15,marginBottom:6,color:V('dim')}}>暂无股票仓位</div>
                  <div style={{fontSize:13}}>期权被行权「接货」时自动建仓 · 或点击「手动添加」</div>
                </div>
              ):(stocks.length>0&&<>
                <StocksTableHeader/>
                {stocks.map(s=><StockRow key={s.id} s={s} onUpdatePrice={updateStockPrice} onDelete={removeStock}/>)}
              </>)}
            </>
          )}

          {/* SGOV Tab */}
          <div style={{display:tab==='sgov'?'block':'none'}}>
            <SgovPanel sgov={sgov} onUpdate={mutateSgov} totalMarginUsed={totalMarginUsed}/>
          </div>

          {/* 观察列表 Tab */}
          <div style={{display:tab==='watchlist'?'block':'none'}}><WatchlistPanel/></div>

          {/* 期权筛选 Tab */}
          <div style={{display:tab==='scan'?'block':'none'}}><ScanPanel/></div>

          {/* 美股日报 / 收藏网站 Tab */}
          <div style={{display:tab==='finews'?'block':'none'}}><LinkHubPanel/></div>

          {/* 期权学习 Tab */}
          <div style={{display:tab==='learn'?'block':'none'}}><LearnPanel/></div>
        </div>
      </div>
    </div>
  );
}

function Root(){
  const [auth,setAuth]=useState(()=>sessionStorage.getItem(LOGIN_KEY)==='1');
  if(!auth)return <LoginScreen onLogin={()=>setAuth(true)}/>;
  return <App/>;
}
export default Root;
