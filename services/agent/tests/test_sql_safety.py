from agent2db.sql_safety import analyze_sql


def test_select_is_read_only():
    result = analyze_sql("select * from users where id = 1")
    assert result.statement_types == ["SELECT"]
    assert result.read_only
    assert result.warnings == []


def test_create_table_is_a_write():
    result = analyze_sql("create table users (id bigint primary key, email text not null)")
    assert result.statement_types == ["CREATE TABLE"]
    assert not result.read_only


def test_delete_without_where_is_flagged():
    result = analyze_sql("delete from users")
    assert result.statement_types == ["DELETE"]
    assert any("without WHERE" in w for w in result.warnings)


def test_update_with_where_is_not_flagged():
    assert analyze_sql("update users set name = 'a' where id = 1").warnings == []


def test_multi_statement_and_drop_are_flagged():
    result = analyze_sql("select 1; drop table users")
    assert result.statement_types == ["SELECT", "DROP"]
    assert not result.read_only
    assert any("2 statements" in w for w in result.warnings)
    assert any("permanently" in w for w in result.warnings)


def test_commit_escape_is_not_read_only():
    result = analyze_sql("commit; drop table users")
    assert "TRANSACTION" in result.statement_types
    assert not result.read_only


def test_data_modifying_cte_is_not_read_only():
    result = analyze_sql("with gone as (delete from users returning id) select count(*) from gone")
    assert not result.read_only
    assert "data-modifying CTE" in result.statement_types[0]


def test_select_into_is_not_read_only():
    assert not analyze_sql("select * into backup_users from users").read_only


def test_explain_analyze_of_write_is_not_read_only():
    assert not analyze_sql("explain analyze delete from users").read_only
    assert analyze_sql("explain select 1").read_only


def test_parse_error_is_not_read_only():
    result = analyze_sql("selec * frm users")
    assert result.parse_error
    assert not result.read_only
